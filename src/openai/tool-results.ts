/**
 * Truncate oversized tool output and build post-tool continuation prompts.
 */
export interface ToolResultContent {
  content: string;
}

/**
 * Max chars of a single mcpResult payload sent back to Cursor.
 * Huge shell/build logs can stall or kill the H2 bridge mid-resume.
 * Override with OPENCODE_CURSOR_MCP_RESULT_MAX_CHARS.
 */
const MCP_RESULT_MAX_CHARS = Number(
  process.env.OPENCODE_CURSOR_MCP_RESULT_MAX_CHARS ?? 24_000,
);
const MCP_RESULT_HEAD_CHARS = Number(
  process.env.OPENCODE_CURSOR_MCP_RESULT_HEAD_CHARS ?? 16_000,
);
const MCP_RESULT_TAIL_CHARS = Number(
  process.env.OPENCODE_CURSOR_MCP_RESULT_TAIL_CHARS ?? 6_000,
);

/**
 * Truncate oversized tool output for Cursor mcpResult / continuation prompts.
 * Keeps head + tail so build success lines near the end stay visible.
 */
export function truncateToolResultForCursor(content: string): string {
  const text = content ?? "";
  if (text.length <= MCP_RESULT_MAX_CHARS) return text;
  const headN = Math.min(MCP_RESULT_HEAD_CHARS, MCP_RESULT_MAX_CHARS);
  const tailN = Math.min(
    MCP_RESULT_TAIL_CHARS,
    Math.max(0, MCP_RESULT_MAX_CHARS - headN),
  );
  const head = text.slice(0, headN);
  const tail = tailN > 0 ? text.slice(-tailN) : "";
  const omitted = Math.max(0, text.length - head.length - tail.length);
  return `${head}\n\n…[truncated ${omitted} chars of tool output for Cursor bridge stability]…\n\n${tail}`;
}

/** Append tool-result payloads to an internal recovery continuation prompt. */
function appendToolResultsToContinuation(
  parts: string[],
  toolResults?: ToolResultContent[],
): void {
  if (!toolResults || toolResults.length === 0) return;
  for (const result of toolResults) {
    const content = result.content.trim() || "(no output)";
    parts.push(truncateToolResultForCursor(content));
  }
}

/**
 * Continuation when a post-tool stream stalls and we rebuild a fresh Run from
 * the stored checkpoint (mcpResults cannot be replayed).
 */
export function buildPostToolStallContinuation(
  toolResults?: ToolResultContent[],
): string {
  const parts: string[] = [
    "Continue from the current conversation checkpoint.",
  ];
  appendToolResultsToContinuation(parts, toolResults);
  return parts.join("\n");
}

/**
 * Continuation when the parked tool bridge died/expired before OpenCode returned
 * results. Always lead with an explicit continue cue.
 */
export function buildPostToolBridgeLossContinuation(
  toolResults?: ToolResultContent[],
): string {
  const parts: string[] = [
    "Continue from the current conversation checkpoint.",
  ];
  appendToolResultsToContinuation(parts, toolResults);
  return parts.join("\n");
}
