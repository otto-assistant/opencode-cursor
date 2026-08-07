/**
 * Truncate oversized tool output and build post-tool continuation prompts.
 */
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { ConversationStateStructureSchema } from "../proto/agent_pb.js";

export interface ToolResultContent {
  content: string;
}

const MCP_RESULT_MAX_CHARS = Number(
  process.env.OPENCODE_CURSOR_MCP_RESULT_MAX_CHARS ?? 24_000,
);
const MCP_RESULT_HEAD_CHARS = Number(
  process.env.OPENCODE_CURSOR_MCP_RESULT_HEAD_CHARS ?? 16_000,
);
const MCP_RESULT_TAIL_CHARS = Number(
  process.env.OPENCODE_CURSOR_MCP_RESULT_TAIL_CHARS ?? 6_000,
);

/** Drop unresolved pending tool calls from a checkpoint after user interrupt. */
export function sanitizeCheckpointAfterInterrupt(
  checkpoint: Uint8Array | null,
): Uint8Array | null {
  if (!checkpoint) return null;
  try {
    const state = fromBinary(ConversationStateStructureSchema, checkpoint);
    if (!state.pendingToolCalls.length) return checkpoint;
    state.pendingToolCalls = [];
    return toBinary(ConversationStateStructureSchema, state);
  } catch {
    return checkpoint;
  }
}

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

/**
 * Continuation when a parked tool bridge is lost or a post-tool stream stalls
 * and must rebuild from checkpoint. Always lead with an explicit continue cue.
 */
export function buildPostToolBridgeLossContinuation(
  toolResults?: ToolResultContent[],
): string {
  const parts: string[] = [
    "Continue from the current conversation checkpoint.",
  ];
  if (toolResults && toolResults.length > 0) {
    for (const result of toolResults) {
      const content = result.content.trim() || "(no output)";
      parts.push(truncateToolResultForCursor(content));
    }
  }
  return parts.join("\n");
}
