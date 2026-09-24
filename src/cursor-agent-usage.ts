import { fromBinary, toBinary, type Message } from "@bufbuild/protobuf";
import {
  fileDesc,
  messageDesc,
  type GenMessage,
} from "@bufbuild/protobuf/codegenv2";
import {
  TurnEndedUpdateSchema,
  type TurnEndedUpdate,
} from "./proto/agent_pb.js";

// Descriptor of proto/agent-v2-usage.proto. Unknown fields survive the shared
// decoder; re-decode only this message using the V2 projection.
const file = fileDesc(
  "ChRhZ2VudC12Mi11c2FnZS5wcm90bxIIYWdlbnQudjEijQIKD1R1cm5FbmRlZFVwZGF0ZRIZCgxpbnB1dF90b2tlbnMYASABKANIAIgBARIaCg1vdXRwdXRfdG9rZW5zGAIgASgDSAGIAQESHgoRY2FjaGVfcmVhZF90b2tlbnMYAyABKANIAogBARIfChJjYWNoZV93cml0ZV90b2tlbnMYBCABKANIA4gBARIdChByZWFzb25pbmdfdG9rZW5zGAUgASgDSASIAQFCDwoNX2lucHV0X3Rva2Vuc0IQCg5fb3V0cHV0X3Rva2Vuc0IUChJfY2FjaGVfcmVhZF90b2tlbnNCFQoTX2NhY2hlX3dyaXRlX3Rva2Vuc0ITChFfcmVhc29uaW5nX3Rva2Vuc2IGcHJvdG8z",
);
export type TurnUsage = Message<"agent.v1.TurnEndedUpdate"> & {
  inputTokens?: bigint;
  outputTokens?: bigint;
  cacheReadTokens?: bigint;
  cacheWriteTokens?: bigint;
  reasoningTokens?: bigint;
};
export const TurnUsageSchema: GenMessage<TurnUsage> = messageDesc(file, 0);

export interface CursorTokenUsage {
  /** AgentService total prompt input, including cache reads and writes. */
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

function count(value: bigint | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Cursor reported an invalid token usage count");
  return Number(value);
}

export function readTurnUsage(
  message: TurnEndedUpdate,
): CursorTokenUsage | undefined {
  const wire = fromBinary(
    TurnUsageSchema,
    toBinary(TurnEndedUpdateSchema, message),
  );
  const usage = {
    input: count(wire.inputTokens),
    output: count(wire.outputTokens),
    cacheRead: count(wire.cacheReadTokens),
    cacheWrite: count(wire.cacheWriteTokens),
    reasoning: count(wire.reasoningTokens),
  };
  if (Object.values(usage).every((value) => value === undefined))
    return undefined;
  if (
    usage.output !== undefined &&
    usage.reasoning !== undefined &&
    usage.reasoning > usage.output
  )
    throw new Error("Cursor reasoning usage exceeds output usage");
  uncachedInputTokens(usage);
  return usage;
}

/** Verified against OAuth Run counters and conversation-correlated billing rows. */
export function uncachedInputTokens(
  usage?: CursorTokenUsage,
): number | undefined {
  if (
    usage?.input === undefined ||
    usage.cacheRead === undefined ||
    usage.cacheWrite === undefined
  )
    return undefined;
  const cached = usage.cacheRead + usage.cacheWrite;
  if (!Number.isSafeInteger(cached) || cached > usage.input)
    throw new Error("Cursor cached token usage exceeds input usage");
  return usage.input - cached;
}
