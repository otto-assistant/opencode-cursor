import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { ConversationStateStructureSchema } from "../proto/agent_pb.js";

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
