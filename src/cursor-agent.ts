/**
 * Native Cursor AgentService transport for OpenCode's LanguageModelV3 adapter.
 *
 * Tool calling uses Cursor's native MCP tool protocol:
 * - OpenAI tool defs → McpToolDefinition in RequestContext
 * - mcpArgs exec → LanguageModelV3 tool calls executed by OpenCode
 * - Follow-up tool results → resume the live Run with mcpResult
 *
 * HTTP/2 transport is delegated to a Node child process (h2-bridge.mjs)
 * because Bun's node:http2 module is broken.
 */
import { create, fromBinary, fromJson, type JsonValue, toBinary, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import {
  AgentClientMessageSchema,
  AgentRunRequestSchema,
  AgentServerMessageSchema,
  CancelActionSchema,
  ClientHeartbeatSchema,
  ConversationActionSchema,
  ConversationStateStructureSchema,
  BackgroundShellSpawnResultSchema,
  CursorRuleSchema,
  CursorRuleTypeSchema,
  CursorRuleTypeGlobalSchema,
  DeleteResultSchema,
  DeleteRejectedSchema,
  DiagnosticsResultSchema,
  ExecClientMessageSchema,
  FetchErrorSchema,
  FetchResultSchema,
  GetBlobResultSchema,
  GrepErrorSchema,
  GrepResultSchema,
  KvClientMessageSchema,
  LsRejectedSchema,
  LsResultSchema,
  McpErrorSchema,
  McpInstructionsSchema,
  McpResultSchema,
  McpSuccessSchema,
  McpTextContentSchema,
  McpToolDefinitionSchema,
  McpToolNotFoundSchema,
  McpToolResultContentItemSchema,
  ModelDetailsSchema,
  RequestedModelSchema,
  RequestedModel_ModelParameterbytesSchema,
  ReadRejectedSchema,
  ReadResultSchema,
  RequestContextResultSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
  SetBlobResultSchema,
  ShellRejectedSchema,
  ShellResultSchema,
  UserMessageActionSchema,
  UserMessageSchema,
  SelectedContextSchema,
  SelectedImageSchema,
  SelectedImage_BlobIdWithDataSchema,
  WriteRejectedSchema,
  WriteResultSchema,
  WriteShellStdinErrorSchema,
  WriteShellStdinResultSchema,
  type AgentServerMessage,
  type ConversationStateStructure,
  type ExecServerMessage,
  type KvServerMessage,
  type McpToolDefinition,
} from "./proto/agent_pb.js";
import { resolveNodeExecutable } from "./node-runtime.js";
import { createHash } from "node:crypto";
import {
  BRIDGE_PATH,
  CURSOR_API_URL,
} from "./cursor-rpc.js";
import {
  type ExtractedImage,
  type OpenAIToolDef,
} from "./openai/types.js";
import { truncateToolResultForCursor } from "./openai/tool-results.js";
import { BridgePool, type BridgeHandle } from "./bridge-pool.js";
import { log } from "./shared/log.js";
import type { CursorModelSelection } from "./model-selection.js";

const CONNECT_END_STREAM_FLAG = 0b00000010;
interface CursorRequestPayload {
  requestBytes: Uint8Array;
  blobStore: Map<string, Uint8Array>;
  mcpTools: McpToolDefinition[];
}

/** A pending tool execution waiting for results from the caller. */
interface PendingExec {
  execId: string;
  execMsgId: number;
  /** Short external ID (≤64 chars) exposed through LanguageModelV3. */
  toolCallId: string;
  toolName: string;
  /** Decoded arguments JSON string for SSE tool_calls emission. */
  decodedArgs: string;
}

const MAX_LIVE_BRIDGE_BLOB_BYTES = Number(process.env.OPENCODE_CURSOR_MAX_BRIDGE_BLOB_BYTES ?? 128 * 1024 * 1024);
const MAX_LIVE_BRIDGE_BLOB_ENTRIES = Number(process.env.OPENCODE_CURSOR_MAX_BRIDGE_BLOB_ENTRIES ?? 8192);

const BRIDGE_POOL_MIN_SIZE = Number(process.env.OPENCODE_CURSOR_BRIDGE_POOL_MIN ?? 2);
const BRIDGE_POOL_MAX_SIZE = Number(process.env.OPENCODE_CURSOR_BRIDGE_POOL_MAX ?? 4);
const BRIDGE_POOL_ENABLED = process.env.OPENCODE_CURSOR_BRIDGE_POOL_DISABLED !== "1";
let bridgePool: BridgePool | undefined;
const nativeBridges = new Set<ReturnType<typeof spawnBridge> | BridgeHandle>();
const nativePendingRuns = new Map<string, NativeRunContext>();
const nativeContexts = new Set<NativeRunContext>();

export function startCursorTransport(): void {
  if (!BRIDGE_POOL_ENABLED || bridgePool) return;
  bridgePool = new BridgePool({
    minSize: BRIDGE_POOL_MIN_SIZE,
    maxSize: BRIDGE_POOL_MAX_SIZE,
  });
  bridgePool.warmup();
}

export function stopCursorTransport(): void {
  for (const context of nativeContexts) {
    if (context.parkTimeout !== undefined) clearTimeout(context.parkTimeout);
    clearInterval(context.heartbeatTimer);
    context.bridge.kill();
  }
  nativeContexts.clear();
  nativePendingRuns.clear();
  for (const bridge of nativeBridges) bridge.kill();
  nativeBridges.clear();
  bridgePool?.shutdown();
  bridgePool = undefined;
}

const systemBlobCache = new Map<string, { blobId: string; bytes: Uint8Array }>();

/** Best-effort CancelAction so Cursor finalizes an interrupted turn cleanly. */
function sendCancelAction(bridge: { alive: boolean; write: (data: Uint8Array) => void }): void {
  if (!bridge.alive) return;
  try {
    const action = create(ConversationActionSchema, {
      action: { case: "cancelAction", value: create(CancelActionSchema, {}) },
    });
    const clientMessage = create(AgentClientMessageSchema, {
      message: { case: "conversationAction", value: action },
    });
    bridge.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
  } catch {
    // Bridge may already be half-closed; ignore.
  }
}

function estimateBlobStoreBytes(blobStore: Map<string, Uint8Array>): number {
  let bytes = 0;
  for (const value of blobStore.values()) {
    bytes += value.byteLength;
  }
  return bytes;
}

function trimBlobStore(
  blobStore: Map<string, Uint8Array>,
  maxBytes: number,
  maxEntries: number,
): number {
  let trimmed = 0;
  let totalBytes = estimateBlobStoreBytes(blobStore);
  while (blobStore.size > maxEntries || totalBytes > maxBytes) {
    const oldestKey = blobStore.keys().next().value;
    if (!oldestKey) break;
    const removed = blobStore.get(oldestKey);
    blobStore.delete(oldestKey);
    if (removed) totalBytes -= removed.byteLength;
    trimmed += 1;
  }
  return trimmed;
}

/** Length-prefix a message: [4-byte BE length][payload] */
function lpEncode(data: Uint8Array): Buffer {
  const buf = Buffer.alloc(4 + data.length);
  buf.writeUInt32BE(data.length, 0);
  buf.set(data, 4);
  return buf;
}

/** Connect protocol frame: [1-byte flags][4-byte BE length][payload] */
function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
  const frame = Buffer.alloc(5 + data.length);
  frame[0] = flags;
  frame.writeUInt32BE(data.length, 1);
  frame.set(data, 5);
  return frame;
}

/**
 * Spawn the Node H2 bridge and return read/write handles.
 * The bridge uses length-prefixed framing on stdin/stdout.
 */
interface SpawnBridgeOptions {
  accessToken: string;
  rpcPath: string;
  url?: string;
}

function spawnBridge(options: SpawnBridgeOptions): {
  proc: ReturnType<typeof Bun.spawn>;
  write: (data: Uint8Array) => void;
  end: () => void;
  kill: () => void;
  onData: (cb: (chunk: Buffer) => void) => void;
  onClose: (cb: (code: number) => void) => void;
  /** True while the bridge subprocess is still running. */
  get alive(): boolean;
} {
  const proc = Bun.spawn([resolveNodeExecutable(), BRIDGE_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });

  const config = JSON.stringify({
    accessToken: options.accessToken,
    url: options.url ?? CURSOR_API_URL,
    path: options.rpcPath,
  });
  proc.stdin.write(lpEncode(new TextEncoder().encode(config)));

  const cbs = {
    data: null as ((chunk: Buffer) => void) | null,
    close: null as ((code: number) => void) | null,
  };

  // Track exit state so late onClose registrations fire immediately.
  let exited = false;
  let exitCode = 1;

  (async () => {
    const reader = proc.stdout.getReader();
    let pending = Buffer.alloc(0);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending = Buffer.concat([pending, Buffer.from(value)]);

        while (pending.length >= 4) {
          const len = pending.readUInt32BE(0);
          if (pending.length < 4 + len) break;
          const payload = pending.subarray(4, 4 + len);
          pending = pending.subarray(4 + len);
          cbs.data?.(Buffer.from(payload));
        }
      }
    } catch {
      // Stream ended
    }

    const code = await proc.exited ?? 1;
    exited = true;
    exitCode = code;
    cbs.close?.(code);
  })();

  return {
    proc,
    get alive() { return !exited; },
    write(data) {
      try { proc.stdin.write(lpEncode(data)); } catch {}
    },
    end() {
      try {
        proc.stdin.write(lpEncode(new Uint8Array(0)));
        proc.stdin.end();
      } catch {}
    },
    kill() {
      try { proc.kill(); } catch {}
    },
    onData(cb) { cbs.data = cb; },
    onClose(cb) {
      if (exited) {
        // Process already exited — invoke immediately so streams don't hang.
        queueMicrotask(() => cb(exitCode));
      } else {
        cbs.close = cb;
      }
    },
  };
}

function buildMcpToolDefinitions(tools: OpenAIToolDef[]): McpToolDefinition[] {
  return tools.map((t) => {
    const fn = t.function;
    const jsonSchema: JsonValue =
      fn.parameters && typeof fn.parameters === "object"
        ? (fn.parameters as JsonValue)
        : { type: "object", properties: {}, required: [] };
    const inputSchema = toBinary(ValueSchema, fromJson(ValueSchema, jsonSchema));
    return create(McpToolDefinitionSchema, {
      name: fn.name,
      description: fn.description || "",
      providerIdentifier: "opencode",
      toolName: fn.name,
      inputSchema,
    });
  });
}

/** Decode a Cursor MCP arg value (protobuf Value bytes) to a JS value. */
function decodeMcpArgValue(value: Uint8Array): unknown {
  try {
    const parsed = fromBinary(ValueSchema, value);
    return toJson(ValueSchema, parsed);
  } catch {}
  return new TextDecoder().decode(value);
}

/** Decode a map of MCP arg values. */
function decodeMcpArgsMap(args: Record<string, Uint8Array>): Record<string, unknown> {
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    decoded[key] = decodeMcpArgValue(value);
  }
  return decoded;
}

function buildCursorRequest(
  selection: CursorModelSelection,
  systemPrompt: string,
  userText: string,
  conversationId: string,
  images: ExtractedImage[] = [],
): CursorRequestPayload {
  const blobStore = new Map<string, Uint8Array>();

  // System prompt → blob store (cached to avoid recalculation)
  let blobEntry = systemBlobCache.get(systemPrompt);
  if (!blobEntry) {
    const systemJson = JSON.stringify({ role: "system", content: systemPrompt });
    const systemBytes = new TextEncoder().encode(systemJson);
    const systemBlobId = new Uint8Array(
      createHash("sha256").update(systemBytes).digest(),
    );
    blobEntry = {
      blobId: Buffer.from(systemBlobId).toString("hex"),
      bytes: systemBytes,
    };
    systemBlobCache.set(systemPrompt, blobEntry);
    if (systemBlobCache.size > 10) {
      const firstKey = systemBlobCache.keys().next().value;
      if (firstKey !== undefined) systemBlobCache.delete(firstKey);
    }
  }
  blobStore.set(blobEntry.blobId, blobEntry.bytes);
  const systemBlobId = Buffer.from(blobEntry.blobId, "hex");

  const conversationState = create(ConversationStateStructureSchema, {
    rootPromptMessagesJson: [systemBlobId],
    turns: [],
    todos: [],
    pendingToolCalls: [],
    previousWorkspaceUris: [],
    fileStates: {},
    fileStatesV2: {},
    summaryArchives: [],
    turnTimings: [],
    subagentStates: {},
    selfSummaryCount: 0,
    readPaths: [],
  });

  const selectedImages = images.map((image) => {
    const blobId = new Uint8Array(createHash("sha256").update(image.bytes).digest());
    const blobIdHex = Buffer.from(blobId).toString("hex");
    blobStore.set(blobIdHex, image.bytes);
    return create(SelectedImageSchema, {
      uuid: crypto.randomUUID(),
      path: image.filename,
      mimeType: image.mimeType,
      dataOrBlobId: {
        case: "blobIdWithData",
        value: create(SelectedImage_BlobIdWithDataSchema, {
          blobId,
          data: image.bytes,
        }),
      },
    });
  });

  const userMessage = create(UserMessageSchema, {
    text: userText,
    messageId: crypto.randomUUID(),
    ...(selectedImages.length > 0
      ? {
          selectedContext: create(SelectedContextSchema, {
            selectedImages,
          }),
        }
      : {}),
  });

  // Store the user message protobuf in blobStore so Cursor can look it up via getBlob.
  // Cursor uses the raw protobuf bytes as the blob ID (not a hash).
  const userMsgBytes = toBinary(UserMessageSchema, userMessage);
  const userMsgBlobId = Buffer.from(userMsgBytes).toString("hex");
  blobStore.set(userMsgBlobId, userMsgBytes);

  if (selectedImages.length > 0) {
    log.info(
      `[cursor-agent] attached ${selectedImages.length} image(s) to UserMessage (${selectedImages
        .map((img) => `${img.path}:${img.mimeType}`)
        .join(", ")})`,
    );
  }

  const action = create(ConversationActionSchema, {
    action: {
      case: "userMessageAction",
      value: create(UserMessageActionSchema, { userMessage }),
    },
  });

  const modelDetails = create(ModelDetailsSchema, {
    modelId: selection.publicId,
    displayModelId: selection.publicId,
    displayName: selection.displayName,
    maxMode: selection.maxMode,
  });
  const requestedModel = create(RequestedModelSchema, {
    modelId: selection.modelId,
    maxMode: selection.maxMode,
    parameters: selection.parameters.map((parameter) =>
      create(RequestedModel_ModelParameterbytesSchema, parameter),
    ),
  });

  const runRequest = create(AgentRunRequestSchema, {
    conversationState,
    action,
    modelDetails,
    requestedModel,
    conversationId,
  });

  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "runRequest", value: runRequest },
  });

  return {
    requestBytes: toBinary(AgentClientMessageSchema, clientMessage),
    blobStore,
    mcpTools: [],
  };
}

function parseConnectEndStream(data: Uint8Array): Error | null {
  try {
    const payload = JSON.parse(new TextDecoder().decode(data));
    const error = payload?.error;
    if (error) {
      const code = error.code ?? "unknown";
      // Strip protobuf debug info from message if present
      let message = error.message ?? "Unknown error";
      const blobMatch = message.match(/Blob not found: ([\d,]+)/);
      if (blobMatch) {
        // Convert the byte list back to see what's being requested
        const bytes: number[] = blobMatch[1].split(',').map((n: string) => parseInt(n.trim()));
        // Try to decode the protobuf blob reference
        let decoded = '';
        try {
          let offset = 0;
          while (offset < bytes.length) {
            const tag = bytes[offset];
            const wireType = tag & 0x07;
            offset++;
            if (wireType === 2) {
              let len = 0, shift = 0;
              do {
                len |= (bytes[offset] & 0x7f) << shift;
                shift += 7;
                offset++;
              } while (bytes[offset-1] & 0x80);
              const content = bytes.slice(offset, offset+len);
              // Look for printable ASCII at the end
              const asciiEnd = content.findIndex((b: number) => b < 32 || b > 126);
              if (asciiEnd > 0 || content.length > 0) {
                decoded = Buffer.from(content.slice(0, asciiEnd > 0 ? asciiEnd : content.length)).toString('ascii');
              }
              offset += len;
            } else if (wireType === 0) {
              let val = 0, shift = 0;
              do {
                val |= (bytes[offset] & 0x7f) << shift;
                shift += 7;
                offset++;
              } while (bytes[offset-1] & 0x80);
            }
          }
        } catch {}
        if (decoded) {
          message = `Blob not found: "${decoded.slice(0, 50)}..."`;
        }
      }
      return new Error(`Connect error ${code}: ${message}`);
    }
    return null;
  } catch {
    return new Error("Failed to parse Connect end stream");
  }
}

function makeHeartbeatBytes(): Uint8Array {
  const heartbeat = create(AgentClientMessageSchema, {
    message: {
      case: "clientHeartbeat",
      value: create(ClientHeartbeatSchema, {}),
    },
  });
  return frameConnectMessage(toBinary(AgentClientMessageSchema, heartbeat));
}

/**
 * Create a stateful parser for Connect protocol frames.
 * Handles buffering partial data across chunks.
 */
function createConnectFrameParser(
  onMessage: (bytes: Uint8Array) => void,
  onEndStream: (bytes: Uint8Array) => void,
): (incoming: Buffer) => void {
  let pending = Buffer.alloc(0);
  return (incoming: Buffer) => {
    pending = Buffer.concat([pending, incoming]);
    while (pending.length >= 5) {
      const flags = pending[0]!;
      const msgLen = pending.readUInt32BE(1);
      if (pending.length < 5 + msgLen) break;
      const messageBytes = pending.subarray(5, 5 + msgLen);
      pending = pending.subarray(5 + msgLen);
      if (flags & CONNECT_END_STREAM_FLAG) {
        onEndStream(messageBytes);
      } else {
        onMessage(messageBytes);
      }
    }
  };
}

const THINKING_TAG_NAMES = ['think', 'thinking', 'reasoning', 'thought', 'think_intent'];
const MAX_THINKING_TAG_LEN = 16; // </think_intent> is 15 chars

/**
 * Strip thinking tags from streamed text, routing tagged content to reasoning.
 * Buffers partial tags across chunk boundaries.
 */
function createThinkingTagFilter(): {
  process(text: string): { content: string; reasoning: string };
  flush(): { content: string; reasoning: string };
} {
  let buffer = '';
  let inThinking = false;

  return {
    process(text: string) {
      const input = buffer + text;
      buffer = '';
      let content = '';
      let reasoning = '';
      let lastIdx = 0;

      const re = new RegExp(`<(/?)(?:${THINKING_TAG_NAMES.join('|')})\\s*>`, 'gi');
      let match: RegExpExecArray | null;
      while ((match = re.exec(input)) !== null) {
        const before = input.slice(lastIdx, match.index);
        if (inThinking) reasoning += before;
        else content += before;
        inThinking = match[1] !== '/';
        lastIdx = re.lastIndex;
      }

      const rest = input.slice(lastIdx);
      // Buffer a trailing '<' that could be the start of a thinking tag.
      const ltPos = rest.lastIndexOf('<');
      if (ltPos >= 0 && rest.length - ltPos < MAX_THINKING_TAG_LEN && /^<\/?[a-z_]*$/i.test(rest.slice(ltPos))) {
        buffer = rest.slice(ltPos);
        const before = rest.slice(0, ltPos);
        if (inThinking) reasoning += before;
        else content += before;
      } else {
        if (inThinking) reasoning += rest;
        else content += rest;
      }

      return { content, reasoning };
    },
    flush() {
      const b = buffer;
      buffer = '';
      if (!b) return { content: '', reasoning: '' };
      return inThinking ? { content: '', reasoning: b } : { content: b, reasoning: '' };
    },
  };
}

interface StreamState {
  toolCallIndex: number;
  pendingExecs: PendingExec[];
  /** Generated (output) tokens for this turn, accumulated from tokenDelta updates. */
  outputTokens: number;
  /**
   * Conversation context size reported by Cursor (`tokenDetails.usedTokens`).
   * This is the input/prompt token count, not the prompt+completion total.
   */
  promptTokens: number;
  /** Fallback prompt size from the previous turn when Cursor omits tokenDetails. */
  fallbackPromptTokens: number;
}

export type CursorRunEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: string;
    }
  | {
      type: "finish";
      reason: "stop" | "tool-calls" | "error";
      promptTokens: number;
      outputTokens: number;
    }
  | { type: "error"; error: Error };

export interface CursorRunInput {
  accessToken: string;
  selection: CursorModelSelection;
  systemPrompt: string;
  userText: string;
  images?: ExtractedImage[];
  tools?: OpenAIToolDef[];
  workspaceRoot?: string;
  abortSignal?: AbortSignal;
  apiUrl?: string;
}

export interface CursorToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function estimatePromptTokens(input: CursorRunInput): number {
  const text = `${input.systemPrompt}\n${input.userText}\n${JSON.stringify(input.tools ?? [])}`;
  return Math.max(1, estimateTokens(text) + (input.images?.length ?? 0) * 1_024);
}

function continuationIdentity(
  selection: CursorModelSelection,
  tools: readonly OpenAIToolDef[],
): string {
  return JSON.stringify({ selection, tools });
}

interface NativeRunContext {
  bridge: ReturnType<typeof spawnBridge> | BridgeHandle;
  heartbeatTimer: NodeJS.Timeout;
  blobStore: Map<string, Uint8Array>;
  mcpTools: McpToolDefinition[];
  state: StreamState;
  workspaceRoot?: string;
  toolsDisabled: boolean;
  systemPrompt: string;
  userText: string;
  continuationIdentity: string;
  parkTimeout?: ReturnType<typeof setTimeout>;
  parkedAt?: number;
}

export function nativeCursorTransportStats(): {
  contexts: number;
  parked: number;
  pendingToolCalls: number;
} {
  return {
    contexts: nativeContexts.size,
    parked: [...nativeContexts].filter((context) => context.parkedAt !== undefined).length,
    pendingToolCalls: nativePendingRuns.size,
  };
}

function maxNativeContexts(): number {
  const configured = Number(process.env.OPENCODE_CURSOR_MAX_ACTIVE_RUNS ?? 12);
  const runLimit = Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : 12;
  return BRIDGE_POOL_ENABLED
    ? Math.min(runLimit, Math.max(1, BRIDGE_POOL_MAX_SIZE))
    : runLimit;
}

function nativeParkTtlMs(): number {
  const configured = Number(
    process.env.OPENCODE_CURSOR_NATIVE_PARK_TTL_MS ?? 5 * 60 * 1000,
  );
  return Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : 5 * 60 * 1000;
}

function admitNativeContext(): void {
  const limit = maxNativeContexts();
  if (nativeContexts.size < limit) return;
  const parked = [...nativeContexts]
    .filter((context) => context.parkedAt !== undefined)
    .sort((a, b) => a.parkedAt! - b.parkedAt!);
  for (const context of parked) {
    disposeNativeContext(context);
    if (nativeContexts.size < limit) return;
  }
  throw new Error(`Cursor AgentService capacity reached (${limit} active Runs)`);
}

export function computeUsage(state: StreamState) {
  const completion_tokens = Math.max(0, Math.floor(state.outputTokens) || 0);
  // Prefer live Cursor context size; otherwise reuse the last known prompt size
  // so OpenCode does not overwrite the session meter with zeros on tool steps.
  const prompt_tokens = Math.max(
    0,
    Math.floor(state.promptTokens > 0 ? state.promptTokens : state.fallbackPromptTokens) || 0,
  );
  const total_tokens = prompt_tokens + completion_tokens;
  return { prompt_tokens, completion_tokens, total_tokens };
}

/** Decode just the prompt/context token count from a persisted checkpoint. */
function processServerMessage(
  msg: AgentServerMessage,
  blobStore: Map<string, Uint8Array>,
  mcpTools: McpToolDefinition[],
  sendFrame: (data: Uint8Array) => void,
  state: StreamState,
  onText: (text: string, isThinking?: boolean) => void,
  onMcpExec: (exec: PendingExec) => void,
  onCheckpoint?: (checkpointBytes: Uint8Array) => void,
  workspaceRoot?: string,
  toolsDisabled?: boolean,
): void {
  const msgCase = msg.message.case;

  if (msgCase === "interactionUpdate") {
    handleInteractionUpdate(msg.message.value, state, onText);
  } else if (msgCase === "kvServerMessage") {
    handleKvMessage(msg.message.value as KvServerMessage, blobStore, sendFrame);
  } else if (msgCase === "execServerMessage") {
    handleExecMessage(
      msg.message.value as ExecServerMessage,
      mcpTools,
      sendFrame,
      onMcpExec,
      workspaceRoot,
      toolsDisabled,
    );
  } else if (msgCase === "conversationCheckpointUpdate") {
    const stateStructure = msg.message.value as ConversationStateStructure;
    if (stateStructure.tokenDetails) {
      const used = Math.max(0, stateStructure.tokenDetails.usedTokens || 0);
      // Cursor reports conversation context fill here (input/prompt size).
      // Keep the largest observed value in the turn so an early checkpoint
      // cannot permanently clamp OpenCode's meter below the true context size.
      if (used > state.promptTokens) state.promptTokens = used;
    }
    if (onCheckpoint) {
      onCheckpoint(toBinary(ConversationStateStructureSchema, stateStructure));
    }
  }
}

function handleInteractionUpdate(
  update: any,
  state: StreamState,
  onText: (text: string, isThinking?: boolean) => void,
): void {
  const updateCase = update.message?.case;

  if (updateCase === "textDelta") {
    const delta = update.message.value.text || "";
    if (delta) onText(delta, false);
  } else if (updateCase === "thinkingDelta") {
    const delta = update.message.value.text || "";
    if (delta) onText(delta, true);
  } else if (updateCase === "tokenDelta") {
    state.outputTokens += update.message.value.tokens ?? 0;
  }
  // toolCallStarted, partialToolCall, toolCallDelta, toolCallCompleted
  // are intentionally ignored. MCP tool calls flow through the exec
  // message path (mcpArgs → mcpResult), not interaction updates.
  // heartbeat is also ignored here — see isServerKeepaliveMessage().
}

/**
 * Cursor keeps the Agent Run stream alive with periodic HeartbeatUpdate
 * frames while the model is silently thinking ("weighing options").
 * Those must NOT reset the stall watchdog: counting them as progress
 * leaves OpenCode hung forever on Grok/long-thinking turns that never
 * emit text/thinking deltas.
 */
export function isServerKeepaliveMessage(msg: AgentServerMessage): boolean {
  if (msg.message.case !== "interactionUpdate") return false;
  const update = msg.message.value as { message?: { case?: string } };
  return update.message?.case === "heartbeat";
}

/** Send a KV client response back to Cursor. */
function sendKvResponse(
  kvMsg: KvServerMessage,
  messageCase: string,
  value: unknown,
  sendFrame: (data: Uint8Array) => void,
): void {
  const response = create(KvClientMessageSchema, {
    id: kvMsg.id,
    message: { case: messageCase as any, value: value as any },
  });
  const clientMsg = create(AgentClientMessageSchema, {
    message: { case: "kvClientMessage", value: response },
  });
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMsg)));
}

function handleKvMessage(
  kvMsg: KvServerMessage,
  blobStore: Map<string, Uint8Array>,
  sendFrame: (data: Uint8Array) => void,
): void {
  const kvCase = kvMsg.message.case;

  if (kvCase === "getBlobArgs") {
    const blobId = kvMsg.message.value.blobId;
    const blobIdKey = Buffer.from(blobId).toString("hex");
    const blobData = blobStore.get(blobIdKey);
    if (!blobData) {
      log.warn(`[cursor-agent] getBlob MISS: ${blobIdKey.slice(0, 16)}... (store has ${blobStore.size} entries)`);
    }
    sendKvResponse(
      kvMsg, "getBlobResult",
      create(GetBlobResultSchema, blobData ? { blobData } : {}),
      sendFrame,
    );
  } else if (kvCase === "setBlobArgs") {
    const { blobId, blobData } = kvMsg.message.value;
    blobStore.set(Buffer.from(blobId).toString("hex"), blobData);
    trimBlobStore(blobStore, MAX_LIVE_BRIDGE_BLOB_BYTES, MAX_LIVE_BRIDGE_BLOB_ENTRIES);
    sendKvResponse(
      kvMsg, "setBlobResult",
      create(SetBlobResultSchema, {}),
      sendFrame,
    );
  }
}

function handleExecMessage(
  execMsg: ExecServerMessage,
  mcpTools: McpToolDefinition[],
  sendFrame: (data: Uint8Array) => void,
  onMcpExec: (exec: PendingExec) => void,
  workspaceRoot?: string,
  toolsDisabled?: boolean,
): void {
  const execCase = execMsg.message.case;

  if (execCase === "requestContextArgs") {
    const MCP_ONLY_RULE = cursorToolInstructions(toolsDisabled ?? false, workspaceRoot);

    const requestContext = create(RequestContextSchema, {
      rules: [
        create(CursorRuleSchema, {
          fullPath: ".cursorrules",
          content: MCP_ONLY_RULE,
          type: create(CursorRuleTypeSchema, {
            type: { case: "global", value: create(CursorRuleTypeGlobalSchema, {}) },
          }),
          source: 0,
        }),
      ],
      repositoryInfo: [],
      tools: toolsDisabled ? [] : mcpTools,
      gitRepos: [],
      projectLayouts: [],
      mcpInstructions: [
        create(McpInstructionsSchema, {
          serverName: "opencode",
          instructions: MCP_ONLY_RULE,
        }),
      ],
      fileContents: {},
      customSubagents: [],
    });
    const result = create(RequestContextResultSchema, {
      result: {
        case: "success",
        value: create(RequestContextSuccessSchema, { requestContext }),
      },
    });
    sendExecResult(execMsg, "requestContextResult", result, sendFrame);
    return;
  }

  if (execCase === "mcpArgs") {
    // OpenCode cannot execute a tool that was not included in this request.
    if (toolsDisabled) {
      log.warn(
        `[cursor-agent] suppressing unavailable MCP tool: ${execMsg.message.value.toolName || execMsg.message.value.name || "unknown"}`,
      );
      const mcpResult = create(McpResultSchema, {
        result: {
          case: "error",
          value: create(McpErrorSchema, {
            error:
              "No tools are available for this request. Respond directly without calling tools.",
          }),
        },
      });
      sendExecResult(execMsg, "mcpResult", mcpResult, sendFrame);
      return;
    }
    const mcpArgs = execMsg.message.value;
    const toolName = mcpArgs.toolName || mcpArgs.name;

    // Reject tool calls that were never advertised to the engine.
    if (mcpTools.length === 0 || !mcpTools.some((t) => t.name === toolName || t.toolName === toolName)) {
      log.warn(
        `[cursor-agent] rejecting unadvertised MCP tool call: ${toolName || "unknown"} (advertised tools: ${mcpTools.length})`,
      );
      const available = mcpTools.map((t) => t.name);
      sendExecResult(
        execMsg,
        "mcpResult",
        create(McpResultSchema, {
          result: {
            case: "toolNotFound",
            value: create(McpToolNotFoundSchema, {
              name: toolName,
              availableTools: available,
            }),
          },
        }),
        sendFrame,
      );
      return;
    }

    const decoded = decodeMcpArgsMap(mcpArgs.args ?? {});
    // Keep provider-facing IDs under common tool-call limits.
    // Some providers reject tool_call IDs longer than 64 characters.
    const shortToolCallId = `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    onMcpExec({
      execId: execMsg.execId,
      execMsgId: execMsg.id,
      toolCallId: shortToolCallId,
      toolName,
      decodedArgs: JSON.stringify(decoded),
    });
    return;
  }

  // --- Reject native Cursor tools ---
  // The model tries these first. We must respond with rejection/error
  // so it falls back to our MCP tools (registered via RequestContext).
  const REJECT_REASON = toolsDisabled
    ? "No tools are available for this request. Respond directly without calling tools."
    : "Tool not available in this environment. Use the MCP tools provided instead.";

  if (execCase === "readArgs") {
    const args = execMsg.message.value;
    const result = create(ReadResultSchema, {
      result: { case: "rejected", value: create(ReadRejectedSchema, { path: args.path, reason: REJECT_REASON }) },
    });
    sendExecResult(execMsg, "readResult", result, sendFrame);
    return;
  }
  if (execCase === "lsArgs") {
    const args = execMsg.message.value;
    const result = create(LsResultSchema, {
      result: { case: "rejected", value: create(LsRejectedSchema, { path: args.path, reason: REJECT_REASON }) },
    });
    sendExecResult(execMsg, "lsResult", result, sendFrame);
    return;
  }
  if (execCase === "grepArgs") {
    const result = create(GrepResultSchema, {
      result: { case: "error", value: create(GrepErrorSchema, { error: REJECT_REASON }) },
    });
    sendExecResult(execMsg, "grepResult", result, sendFrame);
    return;
  }
  if (execCase === "writeArgs") {
    const args = execMsg.message.value;
    const result = create(WriteResultSchema, {
      result: { case: "rejected", value: create(WriteRejectedSchema, { path: args.path, reason: REJECT_REASON }) },
    });
    sendExecResult(execMsg, "writeResult", result, sendFrame);
    return;
  }
  if (execCase === "deleteArgs") {
    const args = execMsg.message.value;
    const result = create(DeleteResultSchema, {
      result: { case: "rejected", value: create(DeleteRejectedSchema, { path: args.path, reason: REJECT_REASON }) },
    });
    sendExecResult(execMsg, "deleteResult", result, sendFrame);
    return;
  }
  if (execCase === "shellArgs" || execCase === "shellStreamArgs") {
    const args = execMsg.message.value;
    const result = create(ShellResultSchema, {
      result: {
        case: "rejected",
        value: create(ShellRejectedSchema, {
          command: args.command ?? "",
          workingDirectory: args.workingDirectory ?? "",
          reason: REJECT_REASON,
          isReadonly: false,
        }),
      },
    });
    sendExecResult(execMsg, "shellResult", result, sendFrame);
    return;
  }
  if (execCase === "backgroundShellSpawnArgs") {
    const args = execMsg.message.value;
    const result = create(BackgroundShellSpawnResultSchema, {
      result: {
        case: "rejected",
        value: create(ShellRejectedSchema, {
          command: args.command ?? "",
          workingDirectory: args.workingDirectory ?? "",
          reason: REJECT_REASON,
          isReadonly: false,
        }),
      },
    });
    sendExecResult(execMsg, "backgroundShellSpawnResult", result, sendFrame);
    return;
  }
  if (execCase === "writeShellStdinArgs") {
    const result = create(WriteShellStdinResultSchema, {
      result: { case: "error", value: create(WriteShellStdinErrorSchema, { error: REJECT_REASON }) },
    });
    sendExecResult(execMsg, "writeShellStdinResult", result, sendFrame);
    return;
  }
  if (execCase === "fetchArgs") {
    const args = execMsg.message.value;
    const result = create(FetchResultSchema, {
      result: { case: "error", value: create(FetchErrorSchema, { url: args.url ?? "", error: REJECT_REASON }) },
    });
    sendExecResult(execMsg, "fetchResult", result, sendFrame);
    return;
  }
  if (execCase === "diagnosticsArgs") {
    const result = create(DiagnosticsResultSchema, {});
    sendExecResult(execMsg, "diagnosticsResult", result, sendFrame);
    return;
  }

  // MCP resource/screen/computer exec types
  const miscCaseMap: Record<string, string> = {
    listMcpResourcesExecArgs: "listMcpResourcesExecResult",
    readMcpResourceExecArgs: "readMcpResourceExecResult",
    recordScreenArgs: "recordScreenResult",
    computerUseArgs: "computerUseResult",
  };
  const resultCase = miscCaseMap[execCase as string];
  if (resultCase) {
    sendExecResult(execMsg, resultCase, create(McpResultSchema, {}), sendFrame);
    return;
  }

  // Unknown exec type — log and ignore
  log.error(`[cursor-agent] unhandled exec: ${execCase}`);
}

/** Send an exec client message back to Cursor. */
function sendExecResult(
  execMsg: ExecServerMessage,
  messageCase: string,
  value: unknown,
  sendFrame: (data: Uint8Array) => void,
): void {
  const execClientMessage = create(ExecClientMessageSchema, {
    id: execMsg.id,
    execId: execMsg.execId,
    message: { case: messageCase as any, value: value as any },
  });
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "execClientMessage", value: execClientMessage },
  });
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
}

function nativeToolSettleMs(): number {
  return Number(process.env.OPENCODE_CURSOR_NATIVE_TOOL_SETTLE_MS ?? 1_000);
}

function preOutputStallTimeoutMs(): number {
  return Number(
    process.env.OPENCODE_CURSOR_PRE_OUTPUT_STALL_TIMEOUT_MS ?? 180_000,
  );
}
/**
 * Pre-output stall budget for POST-TOOL resumes specifically. The model was
 * just active in this conversation (it called a tool seconds earlier), so a
 * long total silence after a tool result is more likely a stuck/dropped
 * Cursor stream than legitimate deep thinking — and the recovery restart
 * (checkpoint + tool results re-attached) is verified safe: it rebuilt a
 * hung session and completed the task. 180s of silence here made chats look
 * hung for 3 minutes; 90s halves that while still covering slow processing.
 * Read dynamically; override with OPENCODE_CURSOR_POST_TOOL_PRE_OUTPUT_STALL_TIMEOUT_MS.
 */
function postToolPreOutputStallTimeoutMs(): number {
  return Number(
    process.env.OPENCODE_CURSOR_POST_TOOL_PRE_OUTPUT_STALL_TIMEOUT_MS ?? 90_000,
  );
}

function nativeOutputStallTimeoutMs(): number {
  return Number(process.env.OPENCODE_CURSOR_STALL_TIMEOUT_MS ?? 45_000);
}

/** Create an SSE streaming Response that reads from a live bridge.
 *  When retryCtx is provided, automatically retries on "Blob not found" errors
 *  by clearing the checkpoint and starting a fresh bridge. */
function startBridge(
  accessToken: string,
  requestBytes: Uint8Array,
  apiUrl: string = CURSOR_API_URL,
): { bridge: ReturnType<typeof spawnBridge> | BridgeHandle; heartbeatTimer: NodeJS.Timeout } {
  const bridge: ReturnType<typeof spawnBridge> | BridgeHandle = bridgePool
    ? bridgePool.acquire({
        accessToken,
        rpcPath: "/agent.v1.AgentService/Run",
        url: apiUrl,
      })
    : spawnBridge({
        accessToken,
        rpcPath: "/agent.v1.AgentService/Run",
        url: apiUrl,
      });
  bridge.write(frameConnectMessage(requestBytes));
  // Heartbeats keep the H2 stream alive. Bridges awaiting tool results are
  // protected from eviction/culling by isAwaitingToolResults(), not by bumping
  // lastAccessMs — which avoids holding JS references that can stall CI tests.
  const heartbeatTimer = setInterval(() => bridge.write(makeHeartbeatBytes()), 5_000);
  return { bridge, heartbeatTimer };
}

/** Start one Cursor AgentService turn and expose semantic events. */
export function runCursorAgent(input: CursorRunInput): ReadableStream<CursorRunEvent> {
  admitNativeContext();
  const payload = buildCursorRequest(
    input.selection,
    input.systemPrompt,
    input.userText,
    crypto.randomUUID(),
    input.images ?? [],
  );
  payload.mcpTools = buildMcpToolDefinitions(input.tools ?? []);
  const { bridge, heartbeatTimer } = startBridge(
    input.accessToken,
    payload.requestBytes,
    input.apiUrl,
  );
  nativeBridges.add(bridge);
  const context: NativeRunContext = {
    bridge,
    heartbeatTimer,
    blobStore: payload.blobStore,
    mcpTools: payload.mcpTools,
    state: {
      toolCallIndex: 0,
      pendingExecs: [],
      outputTokens: 0,
      promptTokens: 0,
      fallbackPromptTokens: estimatePromptTokens(input),
    },
    workspaceRoot: input.workspaceRoot,
    toolsDisabled: payload.mcpTools.length === 0,
    systemPrompt: input.systemPrompt,
    userText: input.userText,
    continuationIdentity: continuationIdentity(input.selection, input.tools ?? []),
  };
  nativeContexts.add(context);
  return createNativeEventStream(context, input.abortSignal);
}

function clearNativePending(context: NativeRunContext): void {
  if (context.parkTimeout !== undefined) {
    clearTimeout(context.parkTimeout);
    context.parkTimeout = undefined;
  }
  context.parkedAt = undefined;
  for (const exec of context.state.pendingExecs) {
    if (nativePendingRuns.get(exec.toolCallId) === context) {
      nativePendingRuns.delete(exec.toolCallId);
    }
  }
}

export function cursorToolInstructions(
  toolsDisabled: boolean,
  workspaceRoot?: string,
): string {
  if (toolsDisabled) {
    return "CRITICAL: No tools are available for this request. Do not call native or MCP tools. Respond directly using only the supplied instructions and context.";
  }
  const workspaceNote = workspaceRoot
    ? ` The project workspace root is "${workspaceRoot}". NEVER use /workspace/ — it does not exist on this system. All file paths must use the real absolute path starting with "${workspaceRoot}".`
    : " NEVER use /workspace/ as a path prefix — it does not exist. Use the absolute paths exactly as provided in the system prompt and tool responses.";
  return `CRITICAL: Do NOT use native tools (read, ls, grep, shell, write, delete, fetch, diagnostics, backgroundShellSpawn, writeShellStdin). They are ALL disabled in this environment. Use ONLY the MCP tools provided in the tools list. Every native tool call will be rejected and waste time. Always use MCP tools for all file operations, shell commands, searches, and any other actions.${workspaceNote}`;
}

function disposeNativeContext(context: NativeRunContext): void {
  clearNativePending(context);
  clearInterval(context.heartbeatTimer);
  context.bridge.kill();
  nativeBridges.delete(context.bridge);
  nativeContexts.delete(context);
}

export function discardCursorAgent(results: readonly CursorToolResult[]): void {
  const contexts = new Set(
    results
      .map((result) => nativePendingRuns.get(result.toolCallId))
      .filter((context): context is NativeRunContext => context !== undefined),
  );
  for (const context of contexts) disposeNativeContext(context);
}

function sendNativeToolResults(
  context: NativeRunContext,
  results: readonly CursorToolResult[],
): void {
  context.state.fallbackPromptTokens = Math.max(
    context.state.promptTokens,
    context.state.fallbackPromptTokens,
  ) + results.reduce((total, result) => total + estimateTokens(result.content), 0);
  context.state.promptTokens = 0;
  for (const exec of context.state.pendingExecs) {
    const result = results.find((item) => item.toolCallId === exec.toolCallId);
    if (!result) throw new Error(`Missing Cursor tool result for ${exec.toolCallId}`);
    const mcpResult = create(McpResultSchema, {
          result: {
            case: "success",
            value: create(McpSuccessSchema, {
              content: [
                create(McpToolResultContentItemSchema, {
                  content: {
                    case: "text",
                    value: create(McpTextContentSchema, {
                      text: truncateToolResultForCursor(result.content),
                    }),
                  },
                }),
              ],
              isError: result.isError ?? false,
            }),
          },
        });
    const execClientMessage = create(ExecClientMessageSchema, {
      id: exec.execMsgId,
      execId: exec.execId,
      message: { case: "mcpResult", value: mcpResult },
    });
    context.bridge.write(
      frameConnectMessage(
        toBinary(
          AgentClientMessageSchema,
          create(AgentClientMessageSchema, {
            message: { case: "execClientMessage", value: execClientMessage },
          }),
        ),
      ),
    );
  }
}

export function resumeCursorAgent(
  results: readonly CursorToolResult[],
  systemPrompt: string,
  userText: string,
  selection: CursorModelSelection,
  tools: readonly OpenAIToolDef[],
  abortSignal?: AbortSignal,
): ReadableStream<CursorRunEvent> | undefined {
  if (results.length === 0) return undefined;
  const contexts = new Set(
    results
      .map((result) => nativePendingRuns.get(result.toolCallId))
      .filter((context): context is NativeRunContext => context !== undefined),
  );
  if (contexts.size !== 1) {
    for (const context of contexts) disposeNativeContext(context);
    return undefined;
  }
  const context = contexts.values().next().value as NativeRunContext;
  const expected = new Set(context.state.pendingExecs.map((exec) => exec.toolCallId));
  const received = new Set(results.map((result) => result.toolCallId));
  const continuationText = userText.startsWith(context.userText)
    ? userText.slice(context.userText.length)
    : undefined;
  if (
    !context.bridge.alive ||
    systemPrompt !== context.systemPrompt ||
    context.continuationIdentity !== continuationIdentity(selection, tools) ||
    continuationText === undefined ||
    continuationText.includes("[OpenCode user]") ||
    expected.size !== context.state.pendingExecs.length ||
    received.size !== results.length ||
    expected.size !== received.size ||
    [...expected].some((toolCallId) => !received.has(toolCallId))
  ) {
    disposeNativeContext(context);
    return undefined;
  }

  clearNativePending(context);
  const stream = createNativeEventStream(context, abortSignal, true);
  sendNativeToolResults(context, results);
  context.state.pendingExecs = [];
  return stream;
}

function createNativeEventStream(
  context: NativeRunContext,
  abortSignal?: AbortSignal,
  resumed = false,
): ReadableStream<CursorRunEvent> {
  const { bridge, heartbeatTimer, blobStore, mcpTools, state } = context;
  const tagFilter = createThinkingTagFilter();
  let closed = false;
  let finishReason: "stop" | "tool-calls" | "error" = "stop";
  let toolFinishTimer: ReturnType<typeof setTimeout> | undefined;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let outputStarted = false;

  return new ReadableStream<CursorRunEvent>({
    start(controller) {
      const cleanup = () => {
        if (toolFinishTimer !== undefined) clearTimeout(toolFinishTimer);
        if (stallTimer !== undefined) clearTimeout(stallTimer);
        abortSignal?.removeEventListener("abort", abort);
      };
      const finish = (reason: typeof finishReason, parked = false) => {
        if (closed) return;
        closed = true;
        finishReason = reason;
        const flushed = tagFilter.flush();
        if (flushed.reasoning) controller.enqueue({ type: "reasoning", text: flushed.reasoning });
        if (flushed.content) controller.enqueue({ type: "text", text: flushed.content });
        const usage = computeUsage(state);
        controller.enqueue({
          type: "finish",
          reason,
          promptTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
        });
        if (parked) {
          context.parkedAt = Date.now();
          for (const exec of state.pendingExecs) {
            nativePendingRuns.set(exec.toolCallId, context);
          }
          context.parkTimeout = setTimeout(() => {
            clearNativePending(context);
            clearInterval(heartbeatTimer);
            bridge.kill();
            nativeBridges.delete(bridge);
            nativeContexts.delete(context);
          }, nativeParkTtlMs());
        } else {
          clearNativePending(context);
          clearInterval(heartbeatTimer);
        }
        cleanup();
        controller.close();
      };
      const fail = (error: Error) => {
        if (closed) return;
        controller.enqueue({ type: "error", error });
        bridge.kill();
        nativeBridges.delete(bridge);
        nativeContexts.delete(context);
        finish("error");
      };
      const scheduleStall = () => {
        if (stallTimer !== undefined) clearTimeout(stallTimer);
        const timeoutMs = outputStarted
          ? nativeOutputStallTimeoutMs()
          : resumed
            ? postToolPreOutputStallTimeoutMs()
            : preOutputStallTimeoutMs();
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
        stallTimer = setTimeout(() => {
          fail(new Error(
            `Cursor AgentService Run stalled for ${timeoutMs}ms without model progress`,
          ));
        }, timeoutMs);
      };
      const abort = () => {
        if (closed) return;
        closed = true;
        sendCancelAction(bridge);
        bridge.kill();
        clearNativePending(context);
        clearInterval(heartbeatTimer);
        nativeBridges.delete(bridge);
        nativeContexts.delete(context);
        cleanup();
        controller.error(abortSignal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      if (abortSignal?.aborted) {
        abort();
        return;
      }
      abortSignal?.addEventListener("abort", abort, { once: true });
      scheduleStall();

      const parseChunk = createConnectFrameParser(
        (messageBytes) => {
          try {
            const message = fromBinary(AgentServerMessageSchema, messageBytes);
            if (!closed && !isServerKeepaliveMessage(message)) scheduleStall();
            processServerMessage(
              message,
              blobStore,
              mcpTools,
              (data) => bridge.write(data),
              state,
              (text, isThinking) => {
                if (closed) return;
                outputStarted = true;
                scheduleStall();
                if (isThinking) {
                  controller.enqueue({ type: "reasoning", text });
                  return;
                }
                const filtered = tagFilter.process(text);
                if (filtered.reasoning) {
                  controller.enqueue({ type: "reasoning", text: filtered.reasoning });
                }
                if (filtered.content) {
                  controller.enqueue({ type: "text", text: filtered.content });
                }
              },
              (exec) => {
                if (closed) {
                  if (context.parkedAt !== undefined) {
                    state.pendingExecs.push(exec);
                    nativePendingRuns.set(exec.toolCallId, context);
                  }
                  return;
                }
                finishReason = "tool-calls";
                outputStarted = true;
                scheduleStall();
                state.pendingExecs.push(exec);
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: exec.toolCallId,
                  toolName: exec.toolName,
                  input: exec.decodedArgs,
                });
                if (toolFinishTimer !== undefined) clearTimeout(toolFinishTimer);
                toolFinishTimer = setTimeout(() => {
                  finish("tool-calls", true);
                }, nativeToolSettleMs());
              },
              undefined,
              context.workspaceRoot,
              context.toolsDisabled,
            );
            if (
              !closed &&
              message.message.case === "interactionUpdate" &&
              message.message.value.message.case === "turnEnded"
            ) {
              bridge.end();
              finish(finishReason);
            }
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        },
        (endStreamBytes) => {
          const error = parseConnectEndStream(endStreamBytes);
          if (!error) return;
          controller.enqueue({ type: "error", error });
          finish("error");
        },
      );
      bridge.onData(parseChunk);
      bridge.onClose((code) => {
        clearNativePending(context);
        clearInterval(heartbeatTimer);
        nativeBridges.delete(bridge);
        nativeContexts.delete(context);
        if (closed) return;
        if (code !== 0 && finishReason !== "tool-calls") {
          controller.enqueue({
            type: "error",
            error: new Error(`Cursor AgentService bridge exited with code ${code}`),
          });
          finish("error");
          return;
        }
        finish(finishReason);
      });
    },
    cancel() {
      if (closed) return;
      closed = true;
      if (toolFinishTimer !== undefined) clearTimeout(toolFinishTimer);
      clearNativePending(context);
      clearInterval(heartbeatTimer);
      sendCancelAction(bridge);
      bridge.kill();
      nativeBridges.delete(bridge);
      nativeContexts.delete(context);
    },
  });
}
