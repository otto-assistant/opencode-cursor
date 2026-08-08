/**
 * OpenCode request classification heuristics.
 *
 * These detect title generation, compaction/summary, post-compact history, and
 * mid-tool-loop user steers from prompt shape. They are compatibility shims —
 * keep them isolated from transport/protocol code.
 */
import type { OpenAIMessage } from "./types.js";
import { textContent } from "./types.js";

/** Detect if this is a title generation request by checking for title-gen system prompt. */
export function isTitleGenerationRequest(messages: OpenAIMessage[]): boolean {
  const systemText = messages
    .filter((m) => m.role === "system")
    .map((m) => textContent(m.content))
    .join(" ");
  return (
    systemText.toLowerCase().includes("title generator") ||
    systemText.toLowerCase().includes("generate a short title")
  );
}

/**
 * Detect OpenCode /compact (compaction) and summary-agent requests.
 * These must not share the live agent conversation checkpoint and must not
 * advertise or emit tools — otherwise Cursor continues the coding agent and
 * OpenCode throws "Tool call not allowed while generating summary".
 */
export function isSummaryGenerationRequest(messages: OpenAIMessage[]): boolean {
  const systemText = messages
    .filter((m) => m.role === "system")
    .map((m) => textContent(m.content))
    .join(" ")
    .toLowerCase();
  if (
    systemText.includes("anchored context summarization") ||
    systemText.includes("summarizing, compacting, or merging context") ||
    systemText.includes("tasked with summarizing conversations") ||
    systemText.includes("write like a pull request description") ||
    systemText.includes("summarize what was done in this conversation")
  ) {
    return true;
  }

  const userText = messages
    .filter((m) => m.role === "user")
    .map((m) => textContent(m.content))
    .join(" ")
    .toLowerCase();
  return (
    userText.includes(
      "this summary will be the only context available when the conversation continues",
    ) ||
    userText.includes(
      "create a detailed summary for continuing this coding session",
    ) ||
    userText.includes("anchored summary from the conversation history") ||
    userText.includes("anchored summary below using the conversation history") ||
    userText.includes("<previous-summary>")
  );
}

/** Namespace prefix so title/summary requests never collide with live agent state. */
export function requestKeyNamespace(messages: OpenAIMessage[]): string {
  if (isTitleGenerationRequest(messages)) return "title:";
  if (isSummaryGenerationRequest(messages)) return "summary:";
  return "";
}

/**
 * True only when the user genuinely INTERRUPTED an unresolved tool batch.
 *
 * A steer exists only when the tool batch opened by the LAST assistant message
 * is still unresolved (no `role: tool` results after it) AND a trailing user
 * message is present. A user message after a completed round is a normal next turn.
 */
export function hasUserSteerAfterTools(messages: OpenAIMessage[]): boolean {
  let tailUserText = "";
  let sawToolResult = false;
  let sawAssistant = false;
  let lastAssistantHasToolCalls = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "system") continue;
    if (msg.role === "user") {
      if (!tailUserText) {
        tailUserText = textContent(msg.content).trim();
      }
      continue;
    }
    if (msg.role === "tool") {
      sawToolResult = true;
      continue;
    }
    if (msg.role === "assistant") {
      lastAssistantHasToolCalls =
        Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
      sawAssistant = true;
      break;
    }
  }
  if (!sawAssistant || !tailUserText) return false;
  return lastAssistantHasToolCalls && !sawToolResult;
}

const INTERRUPT_STEER_PREFIX = "Please follow this new instruction:";

/** Frame a follow-up so Cursor treats it as a steer, not a bare cancel/resume. */
export function buildInterruptSteerUserText(userText: string): string {
  return `${INTERRUPT_STEER_PREFIX}\n\n${userText}`;
}

/**
 * True when the user message is OpenCode's synthetic post-compaction
 * "Continue if you have next steps…" prompt.
 */
export function isCompactionContinueUserText(userText: string): boolean {
  const text = userText.trim().toLowerCase();
  if (!text) return false;
  return (
    text.startsWith("continue if you have next steps") ||
    text.includes(
      "continue if you have next steps, or stop and ask for clarification",
    )
  );
}

/**
 * Pull OpenCode's anchored compaction summary from history (assistant
 * "## Objective" …), if present.
 */
export function extractAnchoredSummary(messages: OpenAIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const text = textContent(msg.content).trim();
    if (
      /^##\s*objective\b/im.test(text) &&
      (/##\s*work state\b/im.test(text) ||
        /\bimportant details\b/i.test(text) ||
        /\bcompleted\b/i.test(text))
    ) {
      return text;
    }
  }
  return "";
}

/**
 * True when OpenCode history is in the post-compaction shape:
 * either the synthetic continue prompt appears, or the session was rewritten
 * to "What did we do so far?" + anchored summary (OpenCode 1.18+).
 */
export function isPostCompactHistory(messages: OpenAIMessage[]): boolean {
  let sawContinue = false;
  let sawWhatDidWeDo = false;
  let sawObjectiveSummary = false;

  for (const msg of messages) {
    const text = textContent(msg.content).trim();
    if (!text) continue;
    if (msg.role === "user") {
      if (isCompactionContinueUserText(text)) sawContinue = true;
      if (/^what did we do so far\??$/i.test(text)) sawWhatDidWeDo = true;
    }
    if (msg.role === "assistant") {
      if (
        /^##\s*objective\b/im.test(text) &&
        (/##\s*work state\b/im.test(text) ||
          /\bcompleted\b/i.test(text) ||
          /\bremaining\b/i.test(text) ||
          /\bimportant details\b/i.test(text))
      ) {
        sawObjectiveSummary = true;
      }
    }
  }

  return sawContinue || (sawWhatDidWeDo && sawObjectiveSummary);
}
