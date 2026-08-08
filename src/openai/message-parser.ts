import { extractImagesFromContent } from "./images.js";
import type {
  ExtractedImage,
  OpenAIMessage,
  ParsedMessages,
  ToolResultInfo,
} from "./types.js";
import { textContent } from "./types.js";

/** Extract the real workspace root from OpenCode's system prompt. */
export function extractWorkspaceRoot(systemPrompt: string): string | undefined {
  return (
    systemPrompt.match(/Working directory:\s*(\S+)/i)?.[1] ??
    systemPrompt.match(/Workspace root folder:\s*(\S+)/i)?.[1]
  );
}

/**
 * Parse OpenAI chat messages into Cursor request inputs.
 *
 * Critical invariant for tool loops: when the latest assistant message still
 * has open `tool_calls` (results are trailing `tool` messages), keep that user
 * text as `userText` and return ONLY those trailing tool results. Flushing the
 * turn early made `userText` empty mid-loop; if the parked bridge was also
 * missing, Cursor then received an empty/continuation UserMessage and models
 * hallucinated "the user sent an empty message".
 *
 * OpenCode history replay sometimes omits `assistant.tool_calls` while still
 * sending the matching `role:tool` results (anomalyco/opencode#24090). Those
 * orphaned tool messages must still open a tool batch — otherwise we return
 * `toolResults=[]` + the original `userText`, kill the parked bridge, and
 * re-prompt Cursor with the same task (infinite re-plan loop).
 */
export function parseMessages(messages: OpenAIMessage[]): ParsedMessages {
  let systemPrompt = "You are a helpful assistant.";
  const pairs: Array<{ userText: string; assistantText: string }> = [];
  const trailingToolResults: ToolResultInfo[] = [];

  const systemParts = messages
    .filter((m) => m.role === "system")
    .map((m) => textContent(m.content));
  if (systemParts.length > 0) {
    systemPrompt = systemParts.join("\n");
  }

  // OpenAI tool-call pattern interleaves assistant(tool_calls) → tool → assistant(text):
  //   user → assistant(tool_calls) → tool → assistant(text+tool_calls) → tool → assistant(text) → user
  // Accumulate assistant text after each user message, but do NOT close the turn
  // while tool_calls are still unresolved.
  const nonSystem = messages.filter((m) => m.role !== "system");
  let pendingUser = "";
  let pendingUserContent: OpenAIMessage["content"] = null;
  let pendingAssistantTexts: string[] = [];
  let openToolCallBatch = false;
  let currentImages: ExtractedImage[] = [];

  function flushPair() {
    if (pendingUser) {
      pairs.push({
        userText: pendingUser,
        assistantText: pendingAssistantTexts.join("\n"),
      });
    }
    pendingUser = "";
    pendingUserContent = null;
    pendingAssistantTexts = [];
    openToolCallBatch = false;
  }

  for (const msg of nonSystem) {
    if (msg.role === "tool") {
      // Infer an open batch when OpenCode dropped assistant.tool_calls on replay.
      if (!openToolCallBatch) {
        openToolCallBatch = true;
        trailingToolResults.length = 0;
      }
      trailingToolResults.push({
        toolCallId: msg.tool_call_id ?? "",
        content: textContent(msg.content),
      });
      continue;
    }

    if (msg.role === "user") {
      flushPair();
      trailingToolResults.length = 0;
      pendingUser = textContent(msg.content);
      pendingUserContent = msg.content;
      currentImages = extractImagesFromContent(msg.content);
      continue;
    }

    if (msg.role === "assistant") {
      const text = textContent(msg.content);
      const hasToolCalls =
        Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
      if (text) {
        pendingAssistantTexts.push(text);
      }
      if (hasToolCalls) {
        // New open batch — older tool results are already historical.
        trailingToolResults.length = 0;
        openToolCallBatch = true;
      } else if (openToolCallBatch) {
        // Assistant completed the tool loop without further tool_calls.
        openToolCallBatch = false;
        trailingToolResults.length = 0;
      }
    }
  }

  let lastUserText = "";
  let lastUserImages: ExtractedImage[] = [];
  if (openToolCallBatch) {
    // Mid tool-loop: preserve the user text and only the unresolved tool results.
    lastUserText = pendingUser;
    lastUserImages = currentImages;
  } else if (pendingUser && pendingAssistantTexts.length > 0) {
    // Capture content before clearing — regeneration reattaches original images.
    const contentForImages = pendingUserContent;
    pairs.push({
      userText: pendingUser,
      assistantText: pendingAssistantTexts.join("\n"),
    });
    pendingUser = "";
    pendingUserContent = null;
    // Regeneration path: last completed turn without a newer user/tool payload.
    if (pairs.length > 0 && trailingToolResults.length === 0) {
      const last = pairs.pop()!;
      lastUserText = last.userText;
      lastUserImages = extractImagesFromContent(contentForImages);
    }
  } else if (pendingUser || currentImages.length > 0) {
    lastUserText = pendingUser;
    lastUserImages = currentImages;
  } else if (pairs.length > 0 && trailingToolResults.length === 0) {
    const last = pairs.pop()!;
    lastUserText = last.userText;
  }

  return {
    systemPrompt,
    userText: lastUserText,
    images: lastUserImages,
    turns: pairs,
    toolResults: trailingToolResults,
  };
}
