/**
 * Local OpenAI-compatible proxy that translates requests to Cursor's gRPC protocol.
 *
 * Accepts POST /v1/chat/completions in OpenAI format, translates to Cursor's
 * protobuf/HTTP2 Connect protocol, and streams back OpenAI-format SSE.
 *
 * Tool calling uses Cursor's native MCP tool protocol:
 * - OpenAI tool defs → McpToolDefinition in RequestContext
 * - Cursor toolCallStarted/Delta/Completed → OpenAI tool_calls SSE chunks
 * - mcpArgs exec → pause stream, return tool_calls to caller
 * - Follow-up request with tool results → resume bridge with mcpResult
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
import { createHash } from "node:crypto";
import { Mutex, isAbortError } from "./promise-queue.js";
import {
  BRIDGE_PATH,
  CURSOR_API_URL,
  callCursorUnaryRpc,
} from "./cursor-rpc.js";
import {
  type ChatCompletionRequest,
  type ExtractedImage,
  type OpenAIToolDef,
  type ToolResultInfo,
  shouldBlockTool,
} from "./openai/types.js";
import { extractImagesFromContent } from "./openai/images.js";
import {
  extractWorkspaceRoot,
  parseMessages,
} from "./openai/message-parser.js";
import {
  buildInterruptSteerUserText,
  extractAnchoredSummary,
  hasUserSteerAfterTools,
  isCompactionContinueUserText,
  isPostCompactHistory,
  isSummaryGenerationRequest,
  isTitleGenerationRequest,
} from "./openai/request-classifier.js";
import {
  buildPostToolBridgeLossContinuation,
  sanitizeCheckpointAfterInterrupt,
  truncateToolResultForCursor,
} from "./openai/tool-results.js";
import {
  deriveBridgeKey,
  deriveConversationKey,
  deterministicConversationId,
  selectionIdentity,
} from "./conversation/identity.js";
import { BridgePool, type BridgeHandle } from "./bridge-pool.js";
import { log } from "./shared/log.js";
import {
  CURSOR_SELECTION_HEADER,
  decodeCursorModelSelection,
  literalCursorModelSelection,
  type CursorModelSelection,
} from "./model-selection.js";

// Re-export pure helpers so existing tests can import from ./proxy
export {
  callCursorUnaryRpc,
  extractImagesFromContent,
  parseMessages,
  isTitleGenerationRequest,
  isSummaryGenerationRequest,
  hasUserSteerAfterTools,
  buildInterruptSteerUserText,
  isCompactionContinueUserText,
  extractAnchoredSummary,
  isPostCompactHistory,
  truncateToolResultForCursor,
  sanitizeCheckpointAfterInterrupt,
  buildPostToolBridgeLossContinuation,
};

const CONNECT_END_STREAM_FLAG = 0b00000010;
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

interface CursorRequestPayload {
  requestBytes: Uint8Array;
  blobStore: Map<string, Uint8Array>;
  mcpTools: McpToolDefinition[];
}

/** A pending tool execution waiting for results from the caller. */
interface PendingExec {
  execId: string;
  execMsgId: number;
  /** Short external ID (≤64 chars) used in OpenAI API tool_calls[].id. */
  toolCallId: string;
  /** Original Cursor tool_call_id for sending mcpResult back. */
  cursorToolCallId: string;
  toolName: string;
  /** Decoded arguments JSON string for SSE tool_calls emission. */
  decodedArgs: string;
}

/** A bridge kept alive across requests for tool result continuation. */
interface ActiveBridge {
  bridge: ReturnType<typeof spawnBridge> | BridgeHandle;
  heartbeatTimer: NodeJS.Timeout;
  blobStore: Map<string, Uint8Array>;
  mcpTools: McpToolDefinition[];
  pendingExecs: PendingExec[];
  lastAccessMs: number;
  /** Present when this bridge was opened from a chat completion that has retry context. */
  resumeRetryCtx?: RetryContext;
  accessToken?: string;
  /** Initial Run frame bytes — used to restart the gRPC stream on stall recovery. */
  requestBytes?: Uint8Array;
}

// Active bridges keyed by a session token (derived from conversation state).
// When tool_calls are returned, the bridge stays alive. The next request
// with tool results looks up the bridge and sends mcpResult messages.
const activeBridges = new Map<string, ActiveBridge>();

interface StoredConversation {
  conversationId: string;
  checkpoint: Uint8Array | null;
  blobStore: Map<string, Uint8Array>;
  lastAccessMs: number;
  /**
   * Last known Cursor conversation context size (`tokenDetails.usedTokens`).
   * Used to keep OpenCode's context meter alive across tool-call steps when a
   * turn ends before a fresh checkpoint arrives.
   */
  lastPromptTokens: number;
  /**
   * True when the previous Cursor turn was aborted by the client (user interrupt)
   * before a natural finish. The next user message should be framed as a steer
   * so the model follows the new instruction instead of resuming cancelled work.
   */
  abortedTurn?: boolean;
}

const conversationStates = new Map<string, StoredConversation>();
/** Last emission time of the user-visible stall wait notice per convKey (tool resumes use new HTTP streams). */
const lastStallWaitNoticeMsByConv = new Map<string, number>();
const CONVERSATION_TTL_MS = 30 * 60 * 1000;
const MUTEX_TTL_MS = 30 * 60 * 1000;
/**
 * TTL for paused tool bridges waiting on OpenCode MCP results.
 *
 * Must cover long legitimate tool runs (installs, builds, systemd bring-up).
 * The previous 5-minute default matched observed "Shell 300.0s" hangs: the
 * bridge was reaped while the tool was still running, so resume could not
 * deliver mcpResults and the agent looked stuck.
 *
 * Abandoned bridges are still reaped after this window so heartbeats/H2
 * workers cannot leak forever. Override with OPENCODE_CURSOR_ACTIVE_BRIDGE_TTL_MS.
 */
const ACTIVE_BRIDGE_TTL_MS = Number(
  process.env.OPENCODE_CURSOR_ACTIVE_BRIDGE_TTL_MS ?? 60 * 60 * 1000,
);

/** Default / configured TTL for paused tool bridges (exported for tests). */
export function getActiveBridgeTtlMs(): number {
  return ACTIVE_BRIDGE_TTL_MS;
}

/** Test-only hooks for bridge eviction/cull regression tests. */
export const __bridgeEvictionTestHooks = {
  activeBridges,
  evictStaleActiveBridges: () => evictStaleActiveBridges(),
  cullOldestIdleBridgesForAdmission: (maxBridges: number) =>
    cullOldestIdleBridgesForAdmission(maxBridges),
  isAwaitingToolResults: (active: ActiveBridge) => isAwaitingToolResults(active),
};
const ADMISSION_BRIDGE_CULL_IDLE_MS = Number(process.env.OPENCODE_CURSOR_ADMISSION_BRIDGE_CULL_IDLE_MS ?? 30 * 1000);
const MAX_ACTIVE_BRIDGES = 24;
const MAX_CONVERSATION_BLOB_BYTES = Number(process.env.OPENCODE_CURSOR_MAX_CONV_BLOB_BYTES ?? 64 * 1024 * 1024);
const MAX_CONVERSATION_BLOB_ENTRIES = Number(process.env.OPENCODE_CURSOR_MAX_CONV_BLOB_ENTRIES ?? 4096);
const MAX_LIVE_BRIDGE_BLOB_BYTES = Number(process.env.OPENCODE_CURSOR_MAX_BRIDGE_BLOB_BYTES ?? 128 * 1024 * 1024);
const MAX_LIVE_BRIDGE_BLOB_ENTRIES = Number(process.env.OPENCODE_CURSOR_MAX_BRIDGE_BLOB_ENTRIES ?? 8192);
const MAX_TOTAL_CONVERSATION_BLOB_BYTES = Number(process.env.OPENCODE_CURSOR_MAX_TOTAL_CONV_BLOB_BYTES ?? 256 * 1024 * 1024);
const MAINTENANCE_INTERVAL_MS = 60 * 1000;

// Bridge pool configuration
const BRIDGE_POOL_MIN_SIZE = Number(process.env.OPENCODE_CURSOR_BRIDGE_POOL_MIN ?? 2);
const BRIDGE_POOL_MAX_SIZE = Number(process.env.OPENCODE_CURSOR_BRIDGE_POOL_MAX ?? 4);
const BRIDGE_POOL_ENABLED = process.env.OPENCODE_CURSOR_BRIDGE_POOL_DISABLED !== "1";
let bridgePool: BridgePool | undefined;

// Per-conversation mutexes — prevent concurrent requests from corrupting
// shared state (blobStore, checkpoints, active bridges).
const convMutexes = new Map<string, Mutex>();
const convMutexLastUsedMs = new Map<string, number>();

const systemBlobCache = new Map<string, { blobId: string; bytes: Uint8Array }>();

let activeRequestCount = 0;
let maintenanceTimer: ReturnType<typeof setInterval> | undefined;

export const proxyTelemetry = {
  capRejects: 0,
  staleConversationEvictions: 0,
  staleMutexEvictions: 0,
  staleBridgeEvictions: 0,
  forcedBridgeKills: 0,
  pressureActivations: 0,
  admissionRejects: 0,
  stallDetections: 0,
  stallRecoveryRetries: 0,
  stallRecoveryFailures: 0,
  maintenanceRuns: 0,
  lastSnapshotMs: 0,
};

function getOrCreateMutex(convKey: string): Mutex {
  let mutex = convMutexes.get(convKey);
  if (!mutex) {
    mutex = new Mutex();
    convMutexes.set(convKey, mutex);
  }
  convMutexLastUsedMs.set(convKey, Date.now());
  return mutex;
}

function deleteActiveBridge(bridgeKey: string): void {
  if (activeBridges.delete(bridgeKey)) {
  }
}

function killActiveBridge(active: ActiveBridge): void {
  proxyTelemetry.forcedBridgeKills += 1;
  clearInterval(active.heartbeatTimer);
  active.bridge.kill();
}

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

function isProxyUnderPressure(): boolean {
  return (
    activeRequestCount >= PRESSURE_ACTIVE_REQUESTS_THRESHOLD ||
    activeBridges.size >= PRESSURE_ACTIVE_BRIDGES_THRESHOLD
  );
}
function shouldRejectByAdmissionControl(): boolean {
  return (
    activeRequestCount > ADMISSION_MAX_ACTIVE_REQUESTS ||
    activeBridges.size >= ADMISSION_MAX_ACTIVE_BRIDGES
  );
}
function setActiveBridge(bridgeKey: string, active: ActiveBridge): boolean {
  if (activeBridges.size >= MAX_ACTIVE_BRIDGES && !activeBridges.has(bridgeKey)) {
    proxyTelemetry.capRejects += 1;
    log.warn(`[proxy] active bridge cap reached (${MAX_ACTIVE_BRIDGES}), rejecting new bridge`);
    killActiveBridge(active);
    return false;
  }
  active.lastAccessMs = Date.now();
  activeBridges.set(bridgeKey, active);
  return true;
}

function evictStaleConversations(): number {
  let evicted = 0;
  const now = Date.now();
  for (const [key, stored] of conversationStates) {
    if (now - stored.lastAccessMs > CONVERSATION_TTL_MS) {
      conversationStates.delete(key);
      lastStallWaitNoticeMsByConv.delete(key);
      evicted += 1;
    }
  }
  return evicted;
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

function enforceConversationBlobBudget(stored: StoredConversation): void {
  const trimmed = trimBlobStore(
    stored.blobStore,
    MAX_CONVERSATION_BLOB_BYTES,
    MAX_CONVERSATION_BLOB_ENTRIES,
  );
  if (trimmed > 0) {
    // Checkpoint can reference evicted blobs; reset to allow safe rebuild.
    stored.checkpoint = null;
  }
}

function enforceGlobalConversationBlobBudget(): void {
  let totalBytes = 0;
  for (const stored of conversationStates.values()) {
    totalBytes += estimateBlobStoreBytes(stored.blobStore);
  }
  if (totalBytes <= MAX_TOTAL_CONVERSATION_BLOB_BYTES) return;

  const ordered = [...conversationStates.entries()].sort(
    (a, b) => a[1].lastAccessMs - b[1].lastAccessMs,
  );
  for (const [key, stored] of ordered) {
    if (totalBytes <= MAX_TOTAL_CONVERSATION_BLOB_BYTES) break;
    totalBytes -= estimateBlobStoreBytes(stored.blobStore);
    conversationStates.delete(key);
    lastStallWaitNoticeMsByConv.delete(key);
  }
}

function evictStaleMutexes(): number {
  let evicted = 0;
  const now = Date.now();
  for (const [key, mutex] of convMutexes) {
    const lastUsedMs = convMutexLastUsedMs.get(key) ?? now;
    if (now - lastUsedMs > MUTEX_TTL_MS && mutex.isIdle()) {
      convMutexes.delete(key);
      convMutexLastUsedMs.delete(key);
      evicted += 1;
    }
  }
  return evicted;
}

/** True while OpenCode still owes tool results for this paused bridge. */
function isAwaitingToolResults(active: ActiveBridge): boolean {
  return active.pendingExecs.length > 0;
}

function evictStaleActiveBridges(): number {
  let evicted = 0;
  const now = Date.now();
  for (const [bridgeKey, active] of activeBridges) {
    // Never kill bridges waiting on MCP/tool round-trips — Discord/OpenCode
    // tool latency routinely exceeds the idle TTL, and eviction makes resume
    // fall back to a fresh Run that drops mcpResult protocol state.
    if (isAwaitingToolResults(active)) continue;
    const idleMs = now - active.lastAccessMs;
    if (idleMs > ACTIVE_BRIDGE_TTL_MS) {
      log.warn(
        `[proxy] evicting stale tool bridge bridgeKey=${bridgeKey} idleMs=${idleMs} ttlMs=${ACTIVE_BRIDGE_TTL_MS} pendingExecs=${active.pendingExecs.length}`,
      );
      killActiveBridge(active);
      deleteActiveBridge(bridgeKey);
      evicted += 1;
    }
  }
  return evicted;
}

function cullOldestIdleBridgesForAdmission(maxBridges: number): number {
  if (activeBridges.size < maxBridges) return 0;
  const now = Date.now();
  const candidates: Array<[string, ActiveBridge]> = [];
  for (const [key, active] of activeBridges) {
    // Never cull bridges waiting on MCP/tool round-trips — the resume would
    // fall back to a fresh Run that drops mcpResult protocol state.
    if (isAwaitingToolResults(active)) continue;
    if (now - active.lastAccessMs >= ADMISSION_BRIDGE_CULL_IDLE_MS) {
      candidates.push([key, active]);
    }
  }
  if (candidates.length === 0) return 0;

  candidates.sort((a, b) => a[1].lastAccessMs - b[1].lastAccessMs);
  let culled = 0;
  for (const [key, active] of candidates) {
    if (activeBridges.size < maxBridges) break;
    killActiveBridge(active);
    deleteActiveBridge(key);
    culled += 1;
  }
  return culled;
}

function runMaintenanceSweep(): void {
  const staleConversations = evictStaleConversations();
  const staleMutexes = evictStaleMutexes();
  const staleBridges = evictStaleActiveBridges();
  enforceGlobalConversationBlobBudget();

  proxyTelemetry.maintenanceRuns += 1;
  proxyTelemetry.staleConversationEvictions += staleConversations;
  proxyTelemetry.staleMutexEvictions += staleMutexes;
  proxyTelemetry.staleBridgeEvictions += staleBridges;

  const now = Date.now();
  if (staleConversations > 0 || staleMutexes > 0 || staleBridges > 0 || now - proxyTelemetry.lastSnapshotMs > 5 * 60 * 1000) {
    proxyTelemetry.lastSnapshotMs = now;
    const poolInfo = bridgePool ? ` pool(idle/active/total)=${bridgePool.stats().idle}/${bridgePool.stats().active}/${bridgePool.stats().total}` : "";
    log.info(
      `[proxy] health activeReq=${activeRequestCount} activeBridges=${activeBridges.size} conv=${conversationStates.size} mutex=${convMutexes.size} ` +
      `evict(conv/mutex/bridge)=${proxyTelemetry.staleConversationEvictions}/${proxyTelemetry.staleMutexEvictions}/${proxyTelemetry.staleBridgeEvictions} ` +
      `capRejects=${proxyTelemetry.capRejects} admissionRejects=${proxyTelemetry.admissionRejects} bridgeKills=${proxyTelemetry.forcedBridgeKills} pressureHits=${proxyTelemetry.pressureActivations} ` +
      `stalls=${proxyTelemetry.stallDetections} stallRetries=${proxyTelemetry.stallRecoveryRetries} stallFailures=${proxyTelemetry.stallRecoveryFailures}` +
      poolInfo,
    );
  }
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
  const proc = Bun.spawn(["node", BRIDGE_PATH], {
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

let proxyServer: ReturnType<typeof Bun.serve> | undefined;
let proxyPort: number | undefined;
let proxyAccessTokenProvider: (() => Promise<string>) | undefined;
let proxyModels: Array<{ id: string; name: string }> = [];
const DEFAULT_MODEL_ID = "default";

/**
 * Optional pinned listen port from OPENCODE_CURSOR_PROXY_PORT.
 * When unset (the default), Bun binds an ephemeral OS port (0).
 */
function preferredProxyPort(): number {
  const raw = process.env.OPENCODE_CURSOR_PROXY_PORT;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 0;
}

/** OpenAI-compatible base URL for the currently listening proxy. */
export function getCursorProxyBaseUrl(): string | undefined {
  if (!proxyPort) return undefined;
  return `http://localhost:${proxyPort}/v1`;
}

function buildOpenAIModelList(models: ReadonlyArray<{ id: string; name: string }>): Array<{
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}> {
  return models.map((model) => ({
    id: model.id,
    object: "model",
    created: 0,
    owned_by: "cursor",
  }));
}

export function getProxyPort(): number | undefined {
  return proxyPort;
}

export async function startProxy(
  getAccessToken: () => Promise<string>,
  models: ReadonlyArray<{ id: string; name: string }> = [],
): Promise<number> {
  proxyAccessTokenProvider = getAccessToken;
  proxyModels = models.map((model) => ({
    id: model.id,
    name: model.name,
  }));
  if (proxyServer && proxyPort) return proxyPort;

  // Initialize bridge pool for connection reuse
  if (BRIDGE_POOL_ENABLED && !bridgePool) {
    bridgePool = new BridgePool({
      minSize: BRIDGE_POOL_MIN_SIZE,
      maxSize: BRIDGE_POOL_MAX_SIZE,
    });
    bridgePool.warmup();
    log.info(`[proxy] bridge pool started min=${BRIDGE_POOL_MIN_SIZE} max=${BRIDGE_POOL_MAX_SIZE}`);
  }

  const listenPort = preferredProxyPort();
  proxyServer = Bun.serve({
    port: listenPort,
    idleTimeout: 255, // max — Cursor responses can take 30s+
    async fetch(req) {
      const url = new URL(req.url);

      // Fast-path: admission control BEFORE incrementing activeRequestCount.
      // Previously, every 503-rejected request incremented the counter, causing
      // a thundering herd — retries kept the count above the threshold forever.
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        runMaintenanceSweep();
        if (activeBridges.size >= ADMISSION_MAX_ACTIVE_BRIDGES) {
          const culled = cullOldestIdleBridgesForAdmission(ADMISSION_MAX_ACTIVE_BRIDGES);
          if (culled > 0) {
            log.warn(`[proxy] admission preflight culled idle bridges=${culled}`);
          }
        }
        if (shouldRejectByAdmissionControl()) {
          proxyTelemetry.admissionRejects += 1;
          return new Response(
            JSON.stringify({
              error: {
                message: "Server is saturated, please retry shortly",
                type: "server_error",
                code: "service_unavailable",
              },
            }),
            {
              status: 503,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "2",
              },
            },
          );
        }
      }

      activeRequestCount += 1;
      try {
        if (req.method === "GET" && url.pathname === "/v1/models") {
          return new Response(
            JSON.stringify({
              object: "list",
              data: buildOpenAIModelList(proxyModels),
            }),
            { headers: { "Content-Type": "application/json" } },
  );
}
        if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
          let release: (() => void) | undefined;
          try {
            // Drop work immediately when OpenCode cancelled a queued/superseded request
            // before we even read the body — otherwise zombies pile up on the mutex.
            if (req.signal.aborted) {
              return new Response(null, { status: 499, statusText: "Client Closed Request" });
            }
            const body = (await req.json()) as ChatCompletionRequest;
            if (req.signal.aborted) {
              return new Response(null, { status: 499, statusText: "Client Closed Request" });
            }
            const msgSummary = body.messages.map((m) => `${m.role}[${(typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.length + ' parts' : 'null')?.slice(0, 40)}]`).join(', ');
            log.info(`[proxy] REQUEST model=${body.model} stream=${body.stream} msgs=${body.messages.length} [${msgSummary.slice(0, 120)}]`);
            if (!proxyAccessTokenProvider) {
              throw new Error("Cursor proxy access token provider not configured");
            }
            const accessToken = await proxyAccessTokenProvider();
            if (req.signal.aborted) {
              return new Response(null, { status: 499, statusText: "Client Closed Request" });
            }

            // Serialize per-conversation requests to prevent race conditions
            // that cause "Blob not found" errors from concurrent state mutations.
            // Intentionally does NOT pass req.signal: like v0.1.39 the mutex
            // waits until released so the queued message is not lost. Passing
            // req.signal (added in 59a2cf9, v0.1.40) caused OpenCode's HTTP
            // timeout to abort the waiter and return 499, making the queued
            // user message silently disappear ("running turn was stopped").
            const convKey = deriveConversationKey(body);
            const mutex = getOrCreateMutex(convKey);
            let acquired: () => void;
            acquired = await mutex.acquire();
            if (req.signal.aborted) {
              acquired();
              return new Response(null, { status: 499, statusText: "Client Closed Request" });
            }
            // Guard against double-release: multiple cleanup paths
            // (closeController, cancel, onClose) can all fire for the same request.
            let released = false;
            release = () => {
              if (released) return;
              released = true;
              convMutexLastUsedMs.set(convKey, Date.now());
              acquired();
            };

            // Pass the real release down so stream cleanup paths can unlock the mutex.
            // We do NOT use done.finally() because the HTTP client (OpenCode) may not
            // close the connection on abort, leaving pipeTo hanging forever.
            const selectedModel = decodeCursorModelSelection(
              req.headers.get(CURSOR_SELECTION_HEADER) ?? undefined,
            );
            const resolvedResponse = await handleChatCompletion(
              body,
              accessToken,
              release,
              selectedModel,
              req.signal,
            );
            // OpenCode/Bun may abort while we were awaiting setup (bridge spawn,
            // etc.) before the stream's abort listener was attached — or after
            // the Response is built but before the body is consumed. Cancel the
            // body so createBridgeStreamResponse.abortFromClient releases the
            // conversation mutex and the interrupt message can proceed.
            if (req.signal.aborted) {
              try {
                await resolvedResponse.body?.cancel?.();
              } catch {
                // ignore
              }
              release?.();
              return new Response(null, { status: 499, statusText: "Client Closed Request" });
            }
            return resolvedResponse;
          } catch (err) {
            release?.();
            if (isAbortError(err) || req.signal.aborted) {
              return new Response(null, { status: 499, statusText: "Client Closed Request" });
            }
            const message = err instanceof Error ? err.message : String(err);
            return new Response(
              JSON.stringify({
                error: { message, type: "server_error", code: "internal_error" },
              }),
              { status: 500, headers: { "Content-Type": "application/json" } },
            );
          }
        }

        return new Response("Not Found", { status: 404 });
      } finally {
        activeRequestCount = Math.max(0, activeRequestCount - 1);
        runMaintenanceSweep();
      }
    },
  });

  maintenanceTimer = setInterval(runMaintenanceSweep, MAINTENANCE_INTERVAL_MS);

  proxyPort = proxyServer.port;
  if (!proxyPort) throw new Error("Failed to bind proxy to a port");
  log.info(`[proxy] listening on http://localhost:${proxyPort}/v1`);
  return proxyPort;
}

export function resolveProxyModelId(
  modelId: string,
  selectedModelId?: string,
): string {
  const selected = selectedModelId?.trim();
  if (selected) return selected === "auto" ? DEFAULT_MODEL_ID : selected;
  // Cursor accepts "default" for server-side model auto-selection, but no
  // longer accepts the older OpenCode/Cursor "auto" alias here.
  if (modelId === "auto") return DEFAULT_MODEL_ID;
  return modelId;
}

export function stopProxy(): void {
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = undefined;
  }
  if (bridgePool) {
    bridgePool.shutdown();
    bridgePool = undefined;
  }
  if (proxyServer) {
    proxyServer.stop();
    proxyServer = undefined;
  }
  proxyPort = undefined;
  proxyAccessTokenProvider = undefined;
  proxyModels = [];
  // Clean up any lingering bridges
  for (const active of activeBridges.values()) {
    killActiveBridge(active);
  }
  activeBridges.clear();
  conversationStates.clear();
  lastStallWaitNoticeMsByConv.clear();
  convMutexes.clear();
  convMutexLastUsedMs.clear();
  systemBlobCache.clear();
  activeRequestCount = 0;
  proxyTelemetry.lastSnapshotMs = 0;
}

/** Handle title-gen through the explicitly configured OpenCode Zen model. */
async function handleTitleGenViaZen(
  modelId: string,
  body: ChatCompletionRequest,
): Promise<Response> {
  const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 28)}`;
  const created = Math.floor(Date.now() / 1000);
  try {
    const zenResponse = await fetch(`${ZEN_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, model: modelId, stream: true }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!zenResponse.ok) {
      log.warn(`[proxy] title-gen Zen returned ${zenResponse.status}, falling back to empty`);
      return buildEmptyTitleResponse(completionId, created, modelId);
    }
    return new Response(zenResponse.body, { headers: SSE_HEADERS });
  } catch (err) {
    log.warn(`[proxy] title-gen Zen failed: ${err}, returning empty`);
    return buildEmptyTitleResponse(completionId, created, modelId);
  }
}

/** Return a clean empty title response — leaves the thread name unchanged. */
function buildEmptyTitleResponse(completionId: string, created: number, modelId: string): Response {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: modelId,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

async function handleChatCompletion(
  body: ChatCompletionRequest,
  accessToken: string,
  release: () => void,
  selectedModel?: CursorModelSelection,
  abortSignal?: AbortSignal,
): Promise<Response> {
  if (body.stream === false) {
    release();
    return new Response(
      JSON.stringify({
        error: {
          message: "streaming required",
          type: "invalid_request_error",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const parsed = parseMessages(body.messages);
  const systemPrompt = parsed.systemPrompt;
  // Treat whitespace-only user payloads as empty — Cursor models otherwise
  // hallucinate "the user sent an empty message" and stop working.
  const userText = parsed.userText.trim();
  const turns = parsed.turns;
  const toolResults = parsed.toolResults;
  const images = parsed.images;
  const selection =
    selectedModel ?? literalCursorModelSelection(resolveProxyModelId(body.model));
  const modelId = selection.publicId;
  const isSummary = isSummaryGenerationRequest(body.messages);
  // /compact and summary agents must never see tools — Cursor would call them
  // and OpenCode throws "Tool call not allowed while generating summary".
  const tools = isSummary
    ? []
    : (body.tools ?? []).filter((tool) => !shouldBlockTool(tool));
  const workspaceRoot = extractWorkspaceRoot(systemPrompt);
  log.info(
    `[proxy] bridge model input=${body.model} resolved=${modelId} server=${selection.modelId} max=${selection.maxMode}${isSummary ? " summary=1" : ""} userChars=${userText.length} images=${images.length} tools=${toolResults.length}`,
  );

  if (!userText && toolResults.length === 0 && images.length === 0) {
    return new Response(
      JSON.stringify({
        error: {
          message: "No user message found",
          type: "invalid_request_error",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (isTitleGenerationRequest(body.messages)) {
    const titleModelId =
      process.env.OPENCODE_CURSOR_TITLE_GEN_MODEL?.trim();
    release();
    if (!titleModelId) {
      return buildEmptyTitleResponse(
        `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 28)}`,
        Math.floor(Date.now() / 1000),
        modelId,
      );
    }
    log.info(`[proxy] title-gen request model=${modelId} → zen ${titleModelId}`);
    return handleTitleGenViaZen(titleModelId, body);
  }

  // bridgeKey: model-specific, for active tool-call bridges
  // convKey: model-independent, for conversation state that survives model switches
  // Summary/compact requests are namespaced so they never reuse the live agent checkpoint.
  const bridgeKey = deriveBridgeKey(selectionIdentity(selection), body);
  const convKey = deriveConversationKey(body);
  const prevStored = conversationStates.get(convKey);
  const checkpointSize = prevStored?.checkpoint?.byteLength ?? 0;
  const blobCount = prevStored?.blobStore?.size ?? 0;
  const blobBytes = prevStored?.blobStore ? estimateBlobStoreBytes(prevStored.blobStore) : 0;
  log.info(`[proxy] keys convKey=${convKey} bridgeKey=${bridgeKey} hasStored=${!!prevStored} hasCheckpoint=${!!prevStored?.checkpoint} turns=${turns.length} toolResults=${toolResults.length} checkpointBytes=${checkpointSize} blobs=${blobCount}/${blobBytes} workspace=${workspaceRoot ?? 'none'}`);

  // Mutex is already held by the fetch() handler — no need to acquire here.

  // A trailing user message after tool results means the user interrupted /
  // steered mid tool-loop. Do NOT resume pending MCP tools — that would ignore
  // the new instruction and continue the aborted turn.
  const userSteeredAfterTools = hasUserSteerAfterTools(body.messages);

  const activeBridge = activeBridges.get(bridgeKey);
  if (activeBridge) {
    activeBridge.lastAccessMs = Date.now();
  }

  if (activeBridge && toolResults.length > 0 && !userSteeredAfterTools) {
    deleteActiveBridge(bridgeKey);
    // Tool-result follow-ups are the normal agent loop, not an interrupt.
    // Clear any abort flag left by OpenCode closing the previous SSE stream
    // so the next user turn is not incorrectly framed as a steer.
    const resumedState = conversationStates.get(convKey);
    if (resumedState) resumedState.abortedTurn = false;

    if (activeBridge.bridge.alive) {
      // Resume the live bridge with tool results
      return handleToolResultResume(
        activeBridge,
        toolResults,
        modelId,
        bridgeKey,
        convKey,
        release,
        workspaceRoot,
        abortSignal,
      );
    }

    // Bridge died (timeout, server disconnect, etc.).
    // Clean up and fall through to start a fresh bridge.
    killActiveBridge(activeBridge);
  }

  // User steer (or any non-tool-resume hit on a parked bridge): cancel + drop it.
  if (activeBridge && activeBridges.has(bridgeKey)) {
    if (userSteeredAfterTools) {
      log.info(
        `[proxy] user steer after tools — abandoning pending tool bridge bridgeKey=${bridgeKey}`,
      );
      sendCancelAction(activeBridge.bridge);
      const steered = conversationStates.get(convKey);
      if (steered) steered.abortedTurn = true;
    }
    killActiveBridge(activeBridge);
    deleteActiveBridge(bridgeKey);
  }

  let stored: StoredConversation | undefined = conversationStates.get(convKey);
  // Summary/compact must start from a clean Cursor conversation — never continue
  // the live coding-agent checkpoint (that re-triggers tool calls mid-summary).
  if (isSummary && stored) {
    conversationStates.delete(convKey);
    lastStallWaitNoticeMsByConv.delete(convKey);
    stored = undefined;
  }
  // Safety: if existing state has a checkpoint but this request has no conversation
  // history (no turns, no tool results), it's likely a key collision with a different
  // conversation type (e.g., title generation vs. regular chat). Reset to avoid
  // "Blob not found" errors from stale checkpoint references.
  if (stored?.checkpoint && turns.length === 0 && toolResults.length === 0) {
    conversationStates.delete(convKey);
    lastStallWaitNoticeMsByConv.delete(convKey);
    stored = undefined;
  }
  if (!stored) {
    stored = {
      conversationId: deterministicConversationId(convKey),
      checkpoint: null,
      blobStore: new Map(),
      lastAccessMs: Date.now(),
      lastPromptTokens: 0,
    };
    conversationStates.set(convKey, stored);
  }
  stored.lastAccessMs = Date.now();
  // Hydrate the prompt-token estimate from a persisted checkpoint when present so
  // the first SSE usage chunk after resume is not stuck at 0 while awaiting Cursor.
  if (stored.lastPromptTokens <= 0 && stored.checkpoint) {
    const usedTokens = readUsedTokensFromCheckpoint(stored.checkpoint);
    if (usedTokens > 0) stored.lastPromptTokens = usedTokens;
  }
  runMaintenanceSweep();

  // Build the request. When tool results are present but the live bridge is
  // gone (TTL eviction during long shells/builds, crash, etc.), resume via
  // checkpoint + continuation prompt — mcpResults cannot be replayed.
  // Note: parseMessages may still surface the original user text alongside
  // tool results; that must not win over the tool continuation.
  const mcpTools = buildMcpToolDefinitions(tools);
  const toolContinuationResume =
    toolResults.length > 0 && !userSteeredAfterTools;
  let effectiveUserText = "";
  if (userSteeredAfterTools && userText) {
    effectiveUserText = userText;
  } else if (toolContinuationResume) {
    effectiveUserText = buildPostToolBridgeLossContinuation(toolResults);
    // Stale abort flags from a prior SSE close must not reframe tool output as
    // a brand-new user instruction — that restarts planning every tool hop.
    if (stored.abortedTurn) {
      stored.abortedTurn = false;
      log.info(
        `[proxy] cleared stale abortedTurn on tool continuation convKey=${convKey}`,
      );
    }
    log.warn(
      `[proxy] tool resume without live bridge — checkpoint continuation convKey=${convKey} tools=${toolResults.length} userChars=${userText.length}`,
    );
  } else {
    effectiveUserText = userText;
  }

  // For fresh conversations (no checkpoint), embed prior conversation turns
  // into the user message so the model has context of previous interactions.
  // When a checkpoint exists, Cursor already has the full conversation state.
  // Summary/compact already receives the history in the OpenAI messages that
  // parseMessages folded into turns — embed them so Cursor can summarize.
  // Tool-continuation resumes already carry structured tool output — do not
  // wrap them in the generic history template.
  if (
    !stored.checkpoint &&
    turns.length > 0 &&
    !toolContinuationResume &&
    !userSteeredAfterTools
  ) {
    const historyLines: string[] = [];
    for (const turn of turns) {
      if (turn.userText) historyLines.push(`User: ${turn.userText}`);
      if (turn.assistantText) historyLines.push(`Assistant: ${turn.assistantText}`);
    }
    if (historyLines.length > 0) {
      effectiveUserText = `[Previous conversation]\n${historyLines.join('\n')}\n\n[Current message]\n${effectiveUserText}`;
      log.info(`[proxy] embedded ${turns.length} prior turns in UserMessage (no checkpoint)`);
    }
  }

  // After a client abort / mid-tool steer, Cursor may still hold an incomplete
  // turn. Clear pending tool calls and explicitly frame the new user message
  // so the model follows the interrupt instead of "resuming" cancelled work.
  // Never apply this to tool-continuation resumes — those are not an interrupt.
  const steerInterrupt =
    !isSummary &&
    !toolContinuationResume &&
    !!userText &&
    (!!stored.abortedTurn || userSteeredAfterTools);
  if (steerInterrupt) {
    stored.checkpoint = sanitizeCheckpointAfterInterrupt(stored.checkpoint);
    effectiveUserText = buildInterruptSteerUserText(effectiveUserText);
    stored.abortedTurn = false;
    log.info(
      `[proxy] interrupt steer framed convKey=${convKey} afterTools=${userSteeredAfterTools}`,
    );
  }

  // Belt-and-suspenders: never send an empty UserMessage to Cursor. Empty
  // prompts reliably produce "user sent an empty message" hallucinations.
  // Image-only turns are valid — Cursor reads attachments from selectedContext.
  if (!effectiveUserText.trim()) {
    if (toolResults.length > 0) {
      effectiveUserText = buildPostToolBridgeLossContinuation(toolResults);
      log.warn(
        `[proxy] empty effectiveUserText recovered via tool continuation convKey=${convKey}`,
      );
    } else if (userText) {
      effectiveUserText = userText;
    } else if (images.length > 0) {
      effectiveUserText = "";
    } else {
      release();
      return new Response(
        JSON.stringify({
          error: {
            message: "No user message found",
            type: "invalid_request_error",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  // Attach images only on fresh user turns / steers — not on tool-continuation
  // rebuilds where the original attachments already live in the checkpoint.
  const requestImages =
    toolContinuationResume && !userSteeredAfterTools ? [] : images;

  const payload = buildCursorRequest(
    selection, systemPrompt, effectiveUserText,
    stored.conversationId, stored.checkpoint, stored.blobStore,
    requestImages,
  );
  payload.mcpTools = mcpTools;

  const retryCtx: RetryContext = {
    stored,
    accessToken,
    selection,
    systemPrompt,
    effectiveUserText,
    images: requestImages,
    mcpTools,
    stallRecoveryCount: 0,
  };

  // Auto model fallback remains literal. Concrete catalog selections carry
  // Cursor's server model, parameters, and max-mode flag in RequestedModel.

  return handleStreamingResponse(
    payload, accessToken, modelId, bridgeKey, convKey, release,
    retryCtx,
    workspaceRoot,
    isSummary,
    abortSignal,
  );
}
/** Convert OpenAI tool definitions to Cursor's MCP tool protobuf format. */
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
  checkpoint: Uint8Array | null,
  existingBlobStore?: Map<string, Uint8Array>,
  images: ExtractedImage[] = [],
): CursorRequestPayload {
  const blobStore = new Map<string, Uint8Array>(existingBlobStore ?? []);

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

  let conversationState;
  if (checkpoint) {
    conversationState = fromBinary(ConversationStateStructureSchema, checkpoint);
  } else {
    // IMPORTANT: Do NOT include turns in the ConversationState for fresh conversations.
    // Cursor's server interprets AgentConversationTurnStructure.user_message as a blob
    // reference (not inline data). For fresh conversations, these blobs don't exist on
    // the server yet, causing "Blob not found" errors. The conversation history is
    // communicated via the action's UserMessage instead — Cursor rebuilds state from that.
    conversationState = create(ConversationStateStructureSchema, {
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
  }

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
      `[proxy] attached ${selectedImages.length} image(s) to UserMessage (${selectedImages
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

export function formatConnectErrorForUser(
  message: string,
  modelId?: string,
): string {
  if (message.includes("not_found")) {
    const label = modelId ? `"${modelId}"` : "This model";
    return `${label} is listed in Cursor but is not available for agent requests on your account. Enable it in Cursor Settings → Models, or try Grok Code Fast 1 / Grok 4 Fast Reasoning.`;
  }
  return message;
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
function readUsedTokensFromCheckpoint(checkpoint: Uint8Array): number {
  try {
    const stateStructure = fromBinary(ConversationStateStructureSchema, checkpoint);
    return Math.max(0, stateStructure.tokenDetails?.usedTokens || 0);
  } catch {
    return 0;
  }
}

function rememberConversationTokens(convKey: string, promptTokens: number): void {
  if (promptTokens <= 0) return;
  const stored = conversationStates.get(convKey);
  if (!stored) return;
  stored.lastPromptTokens = promptTokens;
  stored.lastAccessMs = Date.now();
}

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
      log.warn(`[proxy] getBlob MISS: ${blobIdKey.slice(0, 16)}... (store has ${blobStore.size} entries)`);
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
    const workspaceNote = workspaceRoot
      ? ` The project workspace root is "${workspaceRoot}". NEVER use /workspace/ — it does not exist on this system. All file paths must use the real absolute path starting with "${workspaceRoot}".`
      : " NEVER use /workspace/ as a path prefix — it does not exist. Use the absolute paths exactly as provided in the system prompt and tool responses.";
    const MCP_ONLY_RULE = toolsDisabled
      ? `CRITICAL: You are generating a conversation summary/compaction. Do NOT call any tools (native or MCP) — read, ls, grep, shell, write, delete, fetch, and every MCP tool are forbidden. Output ONLY the requested summary as plain text.`
      : `CRITICAL: Do NOT use native tools (read, ls, grep, shell, write, delete, fetch, diagnostics, backgroundShellSpawn, writeShellStdin). They are ALL disabled in this environment. Use ONLY the MCP tools provided in the tools list. Every native tool call will be rejected and waste time. Always use MCP tools for all file operations, shell commands, searches, and any other actions.${workspaceNote}`;

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
    // During /compact and summary generation, never surface tool calls to OpenCode —
    // it hard-throws "Tool call not allowed while generating summary".
    if (toolsDisabled) {
      log.warn(
        `[proxy] suppressing MCP tool during summary: ${execMsg.message.value.toolName || execMsg.message.value.name || "unknown"}`,
      );
      const mcpResult = create(McpResultSchema, {
        result: {
          case: "error",
          value: create(McpErrorSchema, {
            error:
              "Tools are disabled during summary/compaction. Output the summary as plain text only. Do not call any tools.",
          }),
        },
      });
      sendExecResult(execMsg, "mcpResult", mcpResult, sendFrame);
      return;
    }
    const mcpArgs = execMsg.message.value;
    const toolName = mcpArgs.toolName || mcpArgs.name;

    // Reject tool calls that were never advertised to the engine. Agentic
    // models (Claude, Grok, ...) sometimes emit hallucinated tool calls
    // (e.g. "bash") even when no tools were configured — the classic /compact
    // failure, where OpenCode sends tools: [] and hard-throws "Tool call not
    // allowed while generating summary" if the call is forwarded. Answering
    // with toolNotFound lets the engine recover and produce plain text.
    if (mcpTools.length === 0 || !mcpTools.some((t) => t.name === toolName || t.toolName === toolName)) {
      log.warn(
        `[proxy] rejecting unadvertised MCP tool call: ${toolName || "unknown"} (advertised tools: ${mcpTools.length})`,
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
    const cursorToolCallId = mcpArgs.toolCallId || crypto.randomUUID();
    // Generate a short external ID (≤64 chars) for OpenAI API compatibility.
    // Some providers reject tool_call IDs longer than 64 characters.
    const shortToolCallId = `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    onMcpExec({
      execId: execMsg.execId,
      execMsgId: execMsg.id,
      toolCallId: shortToolCallId,
      cursorToolCallId,
      toolName,
      decodedArgs: JSON.stringify(decoded),
    });
    return;
  }

  // --- Reject native Cursor tools ---
  // The model tries these first. We must respond with rejection/error
  // so it falls back to our MCP tools (registered via RequestContext).
  // During summary/compaction, steer it to plain-text output instead.
  const REJECT_REASON = toolsDisabled
    ? "Tools are disabled during summary/compaction. Output the summary as plain text only."
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
  log.error(`[proxy] unhandled exec: ${execCase}`);
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

/** Context for retrying a streaming request after "Blob not found" errors. */
interface RetryContext {
  stored: StoredConversation;
  accessToken: string;
  selection: CursorModelSelection;
  systemPrompt: string;
  effectiveUserText: string;
  /** Images from the originating user turn — preserved across Run rebuilds. */
  images?: ExtractedImage[];
  mcpTools: McpToolDefinition[];
  /** Consecutive internal stall recoveries without forward progress (reset on progress). */
  stallRecoveryCount: number;
  // Cursor's server still handles the literal default model's auto-selection
  // and rate-limit routing internally.
}

/** Max automatic retries for transient connect errors (e.g. "invalid_argument"). */
const MAX_CONNECT_RETRIES = 3;
/** Base delay in ms for connect-error retry backoff (1s, 2s, 4s). */
const CONNECT_RETRY_BASE_DELAY_MS = 1000;
const PRESSURE_MAX_CONNECT_RETRIES = 1;
const PRESSURE_RETRY_DELAY_MULTIPLIER = 3;
const PRESSURE_ACTIVE_REQUESTS_THRESHOLD = 4;
const PRESSURE_ACTIVE_BRIDGES_THRESHOLD = Math.max(4, Math.floor(MAX_ACTIVE_BRIDGES * 0.7));
const ADMISSION_MAX_ACTIVE_REQUESTS = 12;
const ADMISSION_MAX_ACTIVE_BRIDGES = MAX_ACTIVE_BRIDGES;
const STALL_TIMEOUT_MS = Number(process.env.OPENCODE_CURSOR_STALL_TIMEOUT_MS ?? 45_000);
/**
 * Debounce window after the LAST tool call before finishing the stream with
 * finish_reason=tool_calls. Collects tool calls that arrive in one burst while
 * keeping the agent loop snappy: OpenCode can only start executing tools once
 * the stream closes, so this is added latency per tool iteration. 500ms was
 * conservative; models emit a burst of tool calls within a few ms of each
 * other, so 250ms still collects batches while cutting ~250ms off every
 * single-tool-call iteration (the common agent case).
 */
const TOOL_CALL_DEBOUNCE_MS = Number(
  process.env.OPENCODE_CURSOR_TOOL_DEBOUNCE_MS ?? 250,
);
const STALL_TICK_MS = Number(process.env.OPENCODE_CURSOR_STALL_TICK_MS ?? 1_000);
/**
 * Optional user-visible "still processing" marker. Default 0 (disabled): emitting
 * this as SSE `content` posts into Discord mid-turn and interrupts slow agents.
 * Set OPENCODE_CURSOR_STALL_WAIT_NOTICE_MS > 0 only if you explicitly want it.
 */
const STALL_WAIT_NOTICE_MS = Number(process.env.OPENCODE_CURSOR_STALL_WAIT_NOTICE_MS ?? 0);
/** Minimum gap between those notices for the same conversation across back-to-back tool/MCP resumes. */
const STALL_WAIT_NOTICE_CONV_INTERVAL_MS = Number(
  process.env.OPENCODE_CURSOR_STALL_WAIT_NOTICE_CONV_INTERVAL_MS ?? 120_000,
);
/** Max internal Run-stream restarts per stall episode (resets after forward progress). */
function maxStallRecoveries(): number {
  return Number(process.env.OPENCODE_CURSOR_MAX_STALL_RECOVERIES ?? 3);
}
/** Base delay before restarting the Run stream after a stall (exponential backoff). */
const STALL_RECOVERY_BASE_DELAY_MS = Number(
  process.env.OPENCODE_CURSOR_STALL_RECOVERY_BASE_DELAY_MS ?? 1_000,
);
/**
 * Stall threshold while waiting for model output after MCP tool results.
 * Post-tool thinking is often much slower than the initial turn; a short
 * timeout falsely "recovers" by restarting the original Run and drops mcpResults.
 */
const STALL_TIMEOUT_POST_TOOL_MS = Number(
  process.env.OPENCODE_CURSOR_STALL_TIMEOUT_POST_TOOL_MS ?? 180_000,
);
/**
 * Stall budget while the model has produced NO output at all yet (no text, no
 * reasoning, no tool calls). Reasoning-heavy models (e.g. Cursor's auto-routed
 * opus-class backends) can legitimately think 60-120s before the first delta.
 * The standard 45s budget used to fire mid-thinking, discard the model's work
 * and RE-RUN the whole request — roughly doubling the user-visible latency
 * (observed: a 75s answer = 45s stall + 30s re-run). Before any output we now
 * wait this long before declaring a stall. Read dynamically so it can be
 * tuned at runtime; override with OPENCODE_CURSOR_PRE_OUTPUT_STALL_TIMEOUT_MS.
 */
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
const ZEN_BASE_URL = process.env.OPENCODE_ZEN_BASE_URL ?? "https://opencode.ai/zen/v1";

/** Create an SSE streaming Response that reads from a live bridge.
 *  When retryCtx is provided, automatically retries on "Blob not found" errors
 *  by clearing the checkpoint and starting a fresh bridge. */
function createBridgeStreamResponse(
  bridge: ReturnType<typeof spawnBridge> | BridgeHandle,
  heartbeatTimer: NodeJS.Timeout,
  blobStore: Map<string, Uint8Array>,
  mcpTools: McpToolDefinition[],
  modelId: string,
  bridgeKey: string,
  convKey: string,
  release: () => void,
  retryCtx?: RetryContext,
  /** Access token for connect-error retries (required for auto-retry). */
  accessToken?: string,
  /** Original request bytes for connect-error retries. */
  requestBytes?: Uint8Array,
  /** Real workspace root path (e.g. /data/projects/foo) to inject into RequestContext. */
  workspaceRoot?: string,
  /** Override no-progress threshold for this stream (e.g. post-tool resume). */
  stallTimeoutMs?: number,
  /**
   * When false, a stall must NOT restart the original Run requestBytes (those
   * predate mcpResult writes). Instead we rebuild from the latest checkpoint
   * plus the tool results already delivered on this resume.
   */
  allowForcedStallRecovery: boolean = true,
  /** Tool results already written to the live bridge (post-tool resume only). */
  postedToolResults?: ToolResultInfo[],
  /** When true, advertise no tools and suppress MCP tool_calls (summary/compact). */
  toolsDisabled: boolean = false,
  /**
   * OpenCode/HTTP abort signal. Bun/OpenCode often abort via `req.signal` without
   * reliably cancelling the response ReadableStream; honor the signal so the
   * per-conversation mutex is released and the interrupt message can run.
   */
  abortSignal?: AbortSignal,
): Response {
  const resolvedStallTimeoutMs = stallTimeoutMs ?? STALL_TIMEOUT_MS;
  const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 28)}`;
  const created = Math.floor(Date.now() / 1000);
  let outerReleased = false;
  const safeRelease = () => {
    if (outerReleased) return;
    outerReleased = true;
    release();
  };

  let currentAttemptBridge: ReturnType<typeof spawnBridge> | BridgeHandle | undefined = bridge;
  let currentAttemptHeartbeat: NodeJS.Timeout | undefined = heartbeatTimer;
  // Mutable so post-tool checkpoint rebuilds / connect-error retries update these,
  // and abort-time bridge parking can attach the latest resume context.
  let liveAccessToken = accessToken;
  let liveRequestBytes = requestBytes;

  const cleanupCurrentAttempt = () => {
    if (!currentAttemptBridge) return;
    const active = activeBridges.get(bridgeKey);
    if (active?.bridge === currentAttemptBridge) {
      return;
    }
    if (currentAttemptHeartbeat) {
      clearInterval(currentAttemptHeartbeat);
      currentAttemptHeartbeat = undefined;
    }
    currentAttemptBridge.kill();
    currentAttemptBridge = undefined;
  };

  // Shared stream-lifecycle flag used by both `cancel()` and async bridge callbacks.
  // Must live outside `start()` so retries/enqueues stop immediately after client abort.
  let closed = false;
  /**
   * Visible-text length at the moment of the last stall, shared across stall
   * recovery attempts. A recovery attempt only counts as REAL forward progress
   * when it streams beyond this baseline; re-streaming the same prefix must
   * not reset the recovery budget, otherwise a stuck model that repeats the
   * same text keeps recovery running indefinitely and the OpenCode step never
   * finishes (session frozen mid-answer for minutes).
   */
  let stallTextBaseline = 0;
  /** Set when the SSE stream finished with stop/tool_calls (not a user interrupt). */
  let finishedNaturally = false;
  let interruptMarked = false;
  /** At most one user-visible stall wait notice per streaming HTTP response (including internal stall recoveries). */
  let stallWaitUserNoticeEmittedThisResponse = false;
  /** Stall recovery schedules a backoff before restarting the bridge; abort must clear it. */
  let stallRecoveryBackoffTimer: ReturnType<typeof setTimeout> | undefined;
  /** Debounce timer for collecting multiple tool calls before finishing the stream. */
  let toolCallDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Snapshot of the in-flight attempt so abort-during-debounce can still park
   * the bridge after tool_calls SSE was already sent. OpenCode often aborts the
   * HTTP request as soon as it sees tool_calls, before our debounce fires.
   */
  let parkableToolAttempt:
    | {
        bridge: ReturnType<typeof spawnBridge> | BridgeHandle;
        heartbeatTimer: NodeJS.Timeout;
        blobStore: Map<string, Uint8Array>;
        mcpTools: McpToolDefinition[];
        pendingExecs: PendingExec[];
      }
    | undefined;

  const parkBridgeForToolCalls = (reason: string): boolean => {
    if (!parkableToolAttempt || parkableToolAttempt.pendingExecs.length === 0) {
      return false;
    }
    if (toolCallDebounceTimer !== undefined) {
      clearTimeout(toolCallDebounceTimer);
      toolCallDebounceTimer = undefined;
    }
    const attempt = parkableToolAttempt;
    const attached = setActiveBridge(bridgeKey, {
      bridge: attempt.bridge,
      heartbeatTimer: attempt.heartbeatTimer,
      blobStore: attempt.blobStore,
      mcpTools: attempt.mcpTools,
      pendingExecs: [...attempt.pendingExecs],
      lastAccessMs: Date.now(),
      ...(retryCtx && liveAccessToken && liveRequestBytes
        ? {
            resumeRetryCtx: retryCtx,
            accessToken: liveAccessToken,
            requestBytes: liveRequestBytes,
          }
        : {}),
    });
    if (!attached) {
      log.warn(
        `[proxy] failed to park bridge for tool_calls (${reason}) bridgeKey=${bridgeKey}`,
      );
      return false;
    }
    log.info(
      `[proxy] parked bridge for tool_calls (${reason}) bridgeKey=${bridgeKey} pending=${attempt.pendingExecs.length}`,
    );
    // Once parked, this attempt must not be killed by abort cleanup.
    currentAttemptBridge = undefined;
    currentAttemptHeartbeat = undefined;
    parkableToolAttempt = undefined;
    return true;
  };

  const abortFromClient = (reason: string) => {
    // If tool_calls were already streamed but the debounce has not parked the
    // bridge yet, park now. Otherwise OpenCode's tool-result follow-up finds no
    // live bridge and we fall back to a continuation UserMessage — which, with
    // empty parsed userText, previously looked like an empty user prompt.
    if (!finishedNaturally && parkBridgeForToolCalls(`abort:${reason}`)) {
      finishedNaturally = true;
    }

    // Distinguish user interrupt from OpenCode's normal abort-after-tool_calls.
    if (!finishedNaturally && !interruptMarked) {
      interruptMarked = true;
      const stored = conversationStates.get(convKey);
      if (stored) stored.abortedTurn = true;
      const active = activeBridges.get(bridgeKey);
      // Don't CancelAction a bridge that is parked awaiting tool results — that
      // pause is a natural tool_calls finish, not a mid-turn interrupt.
      if (currentAttemptBridge && active?.bridge !== currentAttemptBridge) {
        sendCancelAction(currentAttemptBridge);
      }
      log.info(
        `[proxy] client interrupt reason=${reason} convKey=${convKey} bridgeKey=${bridgeKey}`,
      );
    }
    if (stallRecoveryBackoffTimer !== undefined) {
      clearTimeout(stallRecoveryBackoffTimer);
      stallRecoveryBackoffTimer = undefined;
    }
    if (toolCallDebounceTimer !== undefined) {
      clearTimeout(toolCallDebounceTimer);
      toolCallDebounceTimer = undefined;
    }
    closed = true;
    cleanupCurrentAttempt();
    safeRelease();
  };

  if (abortSignal) {
    if (abortSignal.aborted) {
      queueMicrotask(() => abortFromClient("req.signal-preabort"));
    } else {
      abortSignal.addEventListener("abort", () => abortFromClient("req.signal"), { once: true });
    }
  }

  const stream = new ReadableStream({
    cancel() {
      abortFromClient("stream.cancel");
    },
    start(controller) {
      const encoder = new TextEncoder();
      const sendSSE = (data: object) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const sendDone = () => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch {
          closed = true;
        }
      };
      const closeController = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // No-op: already closed/canceled from consumer side.
        }
        safeRelease();
      };

      const makeChunk = (
        delta: Record<string, unknown>,
        finishReason: string | null = null,
      ) => ({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: modelId,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      });

      function runAttempt(
        attemptBridge: ReturnType<typeof spawnBridge> | BridgeHandle,
        attemptHeartbeat: NodeJS.Timeout,
        attemptBlobStore: Map<string, Uint8Array>,
        attemptMcpTools: McpToolDefinition[],
        attempt: number,
      ): void {
        currentAttemptBridge = attemptBridge;
        currentAttemptHeartbeat = attemptHeartbeat;
        const state: StreamState = {
          toolCallIndex: 0,
          pendingExecs: [],
          outputTokens: 0,
          promptTokens: 0,
          fallbackPromptTokens: conversationStates.get(convKey)?.lastPromptTokens ?? 0,
        };
        const tagFilter = createThinkingTagFilter();
        let mcpExecReceived = false;
        let anyContentSent = false;
        /** Visible assistant text (not thinking/reasoning). Thinking-only
         *  closes must still count as empty so we retry instead of freezing. */
        let anyVisibleTextSent = false;
        let visibleTextAccum = "";
        let blobNotFound = false;
        let connectError = false;
        let emptyCloseRetry = false;
        let watchdogHandled = false;
        let lastProgressAt = Date.now();
        const markProgress = () => {
          lastProgressAt = Date.now();
        };
        const pressureMode = isProxyUnderPressure();
        if (pressureMode) {
          proxyTelemetry.pressureActivations += 1;
        }
        const maxConnectRetries = pressureMode ? PRESSURE_MAX_CONNECT_RETRIES : MAX_CONNECT_RETRIES;
        const retryDelayMultiplier = pressureMode ? PRESSURE_RETRY_DELAY_MULTIPLIER : 1;

        const resetStallRecovery = () => {
          if (retryCtx) retryCtx.stallRecoveryCount = 0;
        };

        /**
         * Build the trailing usage chunk, or null when we have no context info.
         * Emitting prompt_tokens:0 would overwrite OpenCode's per-step input
         * meter with zero (it does not accumulate input), so we skip it and let
         * OpenCode keep the last known value.
         */
        const makeUsageChunk = () => {
          const usage = computeUsage(state);
          if (usage.prompt_tokens <= 0) return null;
          // Persist prompt size so subsequent tool-resume HTTP streams do not
          // report 0 and wipe OpenCode's session context meter.
          rememberConversationTokens(convKey, usage.prompt_tokens);
          return {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model: modelId,
            choices: [],
            usage,
          };
        };

        const finishStream = (finishReason: string) => {
          finishedNaturally = true;
          sendSSE(makeChunk({}, finishReason));
          const usageChunk = makeUsageChunk();
          if (usageChunk) sendSSE(usageChunk);
          sendDone();
          closeController();
        };

        const processChunk = createConnectFrameParser(
          (messageBytes) => {
            try {
              const serverMessage = fromBinary(
                AgentServerMessageSchema,
                messageBytes,
              );
              // Heartbeats alone are not forward progress — see isServerKeepaliveMessage.
              if (!isServerKeepaliveMessage(serverMessage)) {
                markProgress();
              }
              processServerMessage(
                serverMessage,
                attemptBlobStore,
                attemptMcpTools,
                (data) => attemptBridge.write(data),
                state,
                (text, isThinking) => {
                  markProgress();
                  anyContentSent = true;
                  if (isThinking) {
                    sendSSE(makeChunk({ reasoning_content: text }));
                  } else {
                    const { content, reasoning } = tagFilter.process(text);
                    if (reasoning) sendSSE(makeChunk({ reasoning_content: reasoning }));
                    if (content) {
                      anyVisibleTextSent = true;
                      visibleTextAccum += content;
                      // Reset the stall-recovery budget only on REAL forward
                      // progress (new text beyond the last stall point). A
                      // recovery attempt re-streaming the same prefix must keep
                      // counting against the budget so a stuck model cannot loop
                      // recoveries forever.
                      if (visibleTextAccum.length > stallTextBaseline) {
                        resetStallRecovery();
                      }
                      sendSSE(makeChunk({ content }));
                    }
                  }
                },
                  // onMcpExec — the model wants to execute a tool.
                  (exec) => {
                    if (toolsDisabled) {
                      // Defense in depth: summary/compact must never emit tool_calls SSE.
                      log.warn(
                        `[proxy] dropping tool_calls emission during summary: ${exec.toolName}`,
                      );
                      return;
                    }
                    markProgress();
                    state.pendingExecs.push(exec);
                    mcpExecReceived = true;
                    anyContentSent = true;
                    resetStallRecovery();
                    parkableToolAttempt = {
                      bridge: attemptBridge,
                      heartbeatTimer: attemptHeartbeat,
                      blobStore: attemptBlobStore,
                      mcpTools: attemptMcpTools,
                      pendingExecs: state.pendingExecs,
                    };

                    const flushed = tagFilter.flush();
                    if (flushed.reasoning) sendSSE(makeChunk({ reasoning_content: flushed.reasoning }));
                    if (flushed.content) sendSSE(makeChunk({ content: flushed.content }));

                    const toolCallIndex = state.toolCallIndex++;
                    sendSSE(makeChunk({
                      tool_calls: [{
                        index: toolCallIndex,
                        id: exec.toolCallId,
                        type: "function",
                        function: {
                          name: exec.toolName,
                          arguments: exec.decodedArgs,
                        },
                      }],
                    }));

                    // Debounce: wait a short window after the LAST tool call
                    // before parking the bridge and finishing the stream. When
                    // the model emits multiple tool calls in quick succession
                    // they are all collected first; when it emits tool calls
                    // then sits in reasoning, the debounce fires and
                    // OpenCode can start executing without waiting forever.
                    // If OpenCode aborts during this window, abortFromClient
                    // parks via parkBridgeForToolCalls instead of killing the bridge.
                    if (toolCallDebounceTimer !== undefined) {
                      clearTimeout(toolCallDebounceTimer);
                    }
                    toolCallDebounceTimer = setTimeout(() => {
                      toolCallDebounceTimer = undefined;
                      if (closed) return;
                      if (!parkBridgeForToolCalls("debounce")) {
                        sendSSE(makeChunk({ content: "\n[Error: bridge capacity reached, try again]" }));
                        finishStream("stop");
                        return;
                      }
                      finishStream("tool_calls");
                    }, TOOL_CALL_DEBOUNCE_MS);
                  },
                (checkpointBytes) => {
                  const stored = conversationStates.get(convKey);
                  if (stored) {
                    stored.checkpoint = checkpointBytes;
                    for (const [k, v] of attemptBlobStore) stored.blobStore.set(k, v);
                    enforceConversationBlobBudget(stored);
                    stored.lastAccessMs = Date.now();
                    // processServerMessage already folded tokenDetails into
                    // state.promptTokens (keeping the max); just persist it.
                    rememberConversationTokens(convKey, state.promptTokens);
                    resetStallRecovery();
                  }
                },
                workspaceRoot,
                toolsDisabled,
              );
            } catch {
              // Skip unparseable messages
            }
          },
          (endStreamBytes) => {
            markProgress();
            const endError = parseConnectEndStream(endStreamBytes);
            if (endError) {
              // Auto-retry on "Blob not found" if no content was emitted yet.
              // The error arrives within 1-2s, before any SSE events are sent,
              // so the client never sees the failed attempt.
              if (
                !anyContentSent &&
                endError.message.includes("Blob not found") &&
                attempt === 0 &&
                retryCtx
              ) {
                blobNotFound = true;
                return; // swallow error — onClose will retry
              }
              // Auto-retry on transient connect errors (e.g. "invalid_argument",
              // "resource_exhausted") if no content was emitted and we haven't
              // exhausted retries. resource_exhausted can be temporary server
              // overload that clears after a brief delay.
              // The proxy does NOT switch models on rate limits — it passes
              // every model ID literally to Cursor's API (the legacy "auto"
              // alias is normalized to "default" earlier) and relies on
              // Cursor's server-side routing for rate limits.
              const isRateLimit = endError.message.includes("resource_exhausted");
              if (
                !anyContentSent &&
                !blobNotFound &&
                attempt < maxConnectRetries &&
                liveAccessToken &&
                liveRequestBytes
              ) {
                connectError = true;
                log.warn(`[proxy] Connect error (attempt ${attempt + 1}/${maxConnectRetries + 1}, pressure=${pressureMode}): ${endError.message}`);
                return; // swallow error — onClose will retry
              }

              anyContentSent = true;
              // Map known gRPC codes to user-friendly messages.
              const displayMsg = isRateLimit
                ? `Cursor responded with "resource exhausted" after ${attempt + 1} attempt(s). This may be a temporary server overload or a rate limit. If the model usually works for you, please retry; if the error persists, try switching to a different model.`
                : formatConnectErrorForUser(endError.message, modelId);
              sendSSE(makeChunk({ content: `\n[Error: ${displayMsg}]` }));
            }
          },
        );

        attemptBridge.onData(processChunk);

        const stallTimer = setInterval(() => {
          if (closed || mcpExecReceived || watchdogHandled) {
            clearInterval(stallTimer);
            return;
          }
          const noProgressMs = Date.now() - lastProgressAt;
          // Adaptive stall budget by generation phase:
          // - no output at all yet: the model may legitimately think for a
          //   while (slow reasoning backends) — long pre-output budget so we
          //   never discard its thinking and re-run the request (that roughly
          //   doubles user-visible latency: 45s stall + re-run).
          // - reasoning-only flowing: respect the configured budget (post-tool
          //   resumes use the longer post-tool budget for silent processing).
          // - visible text flowing: a stall is a stuck model — use the
          //   standard short budget so an uncompleted OpenCode step cannot
          //   block the whole session for minutes (message streamed but never
          //   finished freezes the agent mid-sentence and refuses new prompts).
          const effectiveStallTimeoutMs = !anyContentSent
            ? allowForcedStallRecovery
              ? preOutputStallTimeoutMs()
              : postToolPreOutputStallTimeoutMs()
            : anyVisibleTextSent
              ? STALL_TIMEOUT_MS
              : resolvedStallTimeoutMs;
          // Opt-in only: default STALL_WAIT_NOTICE_MS is 0 so Discord bots are
          // not interrupted by a mid-stream "[Info: ...]" content chunk.
          if (
            STALL_WAIT_NOTICE_MS > 0 &&
            !stallWaitUserNoticeEmittedThisResponse &&
            noProgressMs >= STALL_WAIT_NOTICE_MS &&
            noProgressMs < effectiveStallTimeoutMs
          ) {
            stallWaitUserNoticeEmittedThisResponse = true;
            const nowMs = Date.now();
            const lastMs = lastStallWaitNoticeMsByConv.get(convKey) ?? 0;
            if (nowMs - lastMs >= STALL_WAIT_NOTICE_CONV_INTERVAL_MS) {
              lastStallWaitNoticeMsByConv.set(convKey, nowMs);
              log.info(
                `[proxy] stall wait notice bridgeKey=${bridgeKey} noProgressMs=${noProgressMs}`,
              );
              sendSSE(makeChunk({ content: "\n[Info: Cursor is still processing; waiting for response...]" }));
            }
          }
          if (noProgressMs < effectiveStallTimeoutMs) return;

          watchdogHandled = true;
          proxyTelemetry.stallDetections += 1;
          // Remember where this attempt stalled so a recovery attempt that
          // merely re-streams the same prefix is not treated as progress.
          stallTextBaseline = visibleTextAccum.length;
          log.warn(
            `[proxy] stall detected bridgeKey=${bridgeKey} attempt=${attempt} timeoutMs=${effectiveStallTimeoutMs} (phase=${!anyContentSent ? (allowForcedStallRecovery ? "pre-output" : "post-tool-pre-output") : anyVisibleTextSent ? "post-text" : "reasoning"}) allowForcedRecovery=${allowForcedStallRecovery}`,
          );

          // Post-text stalls: the model already started answering; re-running it
          // usually just re-streams the same partial answer. Allow at most one
          // recovery (transient Cursor hiccup) then give an honest terminal
          // error instead of burning the full multi-recovery budget on a stuck
          // model. Other phases respect the configured MAX_STALL_RECOVERIES.
          const stallRecoveryLimit = anyVisibleTextSent
            ? Math.min(1, maxStallRecoveries())
            : maxStallRecoveries();
          const canRecover =
            !!retryCtx &&
            !!liveAccessToken &&
            retryCtx.stallRecoveryCount < stallRecoveryLimit &&
            (allowForcedStallRecovery
              ? !!liveRequestBytes
              : true /* checkpoint rebuild path */);

          if (canRecover && retryCtx && liveAccessToken) {
            retryCtx.stallRecoveryCount += 1;
            proxyTelemetry.stallRecoveryRetries += 1;
            const n = retryCtx.stallRecoveryCount;
            const delay = STALL_RECOVERY_BASE_DELAY_MS * Math.pow(2, n - 1);
            const useOriginalBytes = allowForcedStallRecovery && !!liveRequestBytes;
            log.warn(
              `[proxy] forced_recovery_retry_started bridgeKey=${bridgeKey} stallRecoveryAttempt=${n}/${stallRecoveryLimit} delayMs=${delay} mode=${useOriginalBytes ? "replay-run" : "checkpoint-rebuild"}`,
            );

            deleteActiveBridge(bridgeKey);
            clearInterval(stallTimer);
            clearInterval(attemptHeartbeat);
            attemptBridge.kill();
            currentAttemptBridge = undefined;
            currentAttemptHeartbeat = undefined;

            stallRecoveryBackoffTimer = setTimeout(() => {
              stallRecoveryBackoffTimer = undefined;
              if (closed) return;

              if (useOriginalBytes && liveRequestBytes) {
                const { bridge: retryBridge, heartbeatTimer: retryTimer } =
                  startBridge(liveAccessToken!, liveRequestBytes);
                runAttempt(retryBridge, retryTimer, attemptBlobStore, attemptMcpTools, attempt + 1);
                return;
              }

              // Post-tool (or otherwise non-replayable) stall: rebuild a fresh
              // Run from the latest checkpoint and re-attach tool results as a
              // continuation user message. Restarting the original requestBytes
              // would drop mcpResults already written to the dead bridge.
              const continuation = buildPostToolBridgeLossContinuation(postedToolResults);
              const freshPayload = buildCursorRequest(
                retryCtx.selection,
                retryCtx.systemPrompt,
                continuation,
                retryCtx.stored.conversationId,
                retryCtx.stored.checkpoint,
                retryCtx.stored.blobStore,
                // Images already live in the checkpoint; don't re-attach on stall rebuild.
              );
              freshPayload.mcpTools = retryCtx.mcpTools;
              liveAccessToken = retryCtx.accessToken;
              liveRequestBytes = freshPayload.requestBytes;
              const { bridge: retryBridge, heartbeatTimer: retryTimer } =
                startBridge(liveAccessToken, liveRequestBytes);
              runAttempt(
                retryBridge,
                retryTimer,
                freshPayload.blobStore,
                freshPayload.mcpTools,
                attempt + 1,
              );
            }, delay);
            return;
          }

          // Diagnostic: log why recovery was skipped
          log.warn(
            `[proxy] stall recovery skipped bridgeKey=${bridgeKey} allowForcedRecovery=${allowForcedStallRecovery} retryCtx=${!!retryCtx} stallRecoveryCount=${retryCtx?.stallRecoveryCount ?? "n/a"} max=${maxStallRecoveries()} accessToken=${!!liveAccessToken} requestBytes=${!!liveRequestBytes}`,
          );
          proxyTelemetry.stallRecoveryFailures += 1;
          // Honest terminal error — do NOT claim "retrying" when we are not.
          // OpenCode will not auto-retry a finished stop stream; a fake
          // "retrying..." message left agents hung until the user nudged them.
          sendSSE(makeChunk({
            content: "\n[Error: stream stalled; automatic recovery exhausted. Please resend your message.]",
          }));
          finishStream("stop");
          deleteActiveBridge(bridgeKey);
          clearInterval(attemptHeartbeat);
          attemptBridge.kill();
        }, STALL_TICK_MS);

        attemptBridge.onClose((code) => {
          clearInterval(stallTimer);
          clearInterval(attemptHeartbeat);
          if (watchdogHandled) {
            return;
          }
          const stored = conversationStates.get(convKey);
          if (stored) {
            for (const [k, v] of attemptBlobStore) stored.blobStore.set(k, v);
            enforceConversationBlobBudget(stored);
            stored.lastAccessMs = Date.now();
          }

          // Retry: clear stale checkpoint and start a fresh bridge
          if (blobNotFound && !anyContentSent && attempt === 0 && retryCtx) {
            log.warn("[proxy] Blob not found, retrying without checkpoint");
            if (stored) {
              stored.checkpoint = null;
              stored.blobStore.clear();
            }
            deleteActiveBridge(bridgeKey);
            attemptBridge.kill();

            const freshPayload = buildCursorRequest(
              retryCtx.selection,
              retryCtx.systemPrompt,
              retryCtx.effectiveUserText,
              retryCtx.stored.conversationId,
              null, // no checkpoint
              retryCtx.stored.blobStore,
              retryCtx.images ?? [],
            );
            freshPayload.mcpTools = retryCtx.mcpTools;
            liveAccessToken = retryCtx.accessToken;
            liveRequestBytes = freshPayload.requestBytes;
            const { bridge: newBridge, heartbeatTimer: newTimer } =
              startBridge(liveAccessToken, liveRequestBytes);
            runAttempt(newBridge, newTimer, freshPayload.blobStore, freshPayload.mcpTools, 1);
            return;
          }

          // Retry on transient connect errors with exponential backoff.
          // The setTimeout is scoped inside the ReadableStream — if the client
          // aborts (otto abort), the stream closes and safeRelease fires,
          // so no further retries will execute.
          if (connectError && !anyContentSent && attempt < maxConnectRetries && liveAccessToken && liveRequestBytes) {
            deleteActiveBridge(bridgeKey);
            attemptBridge.kill();
            const delay = CONNECT_RETRY_BASE_DELAY_MS * retryDelayMultiplier * Math.pow(2, attempt);
            log.warn(`[proxy] Retrying connect in ${delay}ms (attempt ${attempt + 1}/${maxConnectRetries + 1}, pressure=${pressureMode})`);
            setTimeout(() => {
              // If the stream was already closed (client abort), don't retry.
              if (closed) return;
              const { bridge: retryBridge, heartbeatTimer: retryTimer } =
                startBridge(liveAccessToken!, liveRequestBytes!);
              runAttempt(retryBridge, retryTimer, attemptBlobStore, attemptMcpTools, attempt + 1);
            }, delay);
            return;
          }

          // Flush any buffered visible text before empty / unfinished-plan checks
          // so we do not miss a trailing plan sentence still sitting in the filter.
          {
            const flushedEarly = tagFilter.flush();
            if (flushedEarly.reasoning) {
              sendSSE(makeChunk({ reasoning_content: flushedEarly.reasoning }));
            }
            if (flushedEarly.content) {
              anyVisibleTextSent = true;
              anyContentSent = true;
              visibleTextAccum += flushedEarly.content;
              sendSSE(makeChunk({ content: flushedEarly.content }));
            }
          }

          // Guard against silent empty completions: stream closed before any usable
          // content or tool call reached SSE, but no explicit Connect error surfaced.
          // This happens when Cursor silently rejects large conversation states.
          // Also treat thinking-only closes as empty — OpenCode shows nothing and
          // the agent looks frozen.
          // Strategy: retry once with the same request, then retry once more with
          // a cleared checkpoint (fresh conversation state).
          const usableOutput = mcpExecReceived || anyVisibleTextSent;
          if (!usableOutput && attempt < maxConnectRetries && liveAccessToken && liveRequestBytes) {
            emptyCloseRetry = true;
            if (anyContentSent && !anyVisibleTextSent) {
              log.warn(
                `[proxy] thinking-only stream close — treating as empty (bridgeKey=${bridgeKey})`,
              );
            }
          }
          if (emptyCloseRetry) {
            deleteActiveBridge(bridgeKey);
            attemptBridge.kill();
            const retryAccessToken = liveAccessToken;
            const retryRequestBytes = liveRequestBytes;
            if (!retryAccessToken || !retryRequestBytes) {
              emptyCloseRetry = false;
            } else {
              const delay = Math.max(50, Math.floor((CONNECT_RETRY_BASE_DELAY_MS * retryDelayMultiplier * Math.pow(2, attempt)) / 2));

              // On 2nd+ attempt with empty close, try clearing the checkpoint.
              // Large checkpoints cause Cursor to silently drop the connection.
              let effectiveRequestBytes = retryRequestBytes;
              const isRetryAfterEmpty = attempt >= 1;
              if (isRetryAfterEmpty && retryCtx && retryCtx.stored.checkpoint) {
                log.warn(
                  `[proxy] Empty stream close after retry; clearing checkpoint and rebuilding request (convKey=${convKey})`,
                );
                retryCtx.stored.checkpoint = null;
                retryCtx.stored.blobStore.clear();
                const freshPayload = buildCursorRequest(
                  retryCtx.selection,
                  retryCtx.systemPrompt,
                  retryCtx.effectiveUserText,
                  retryCtx.stored.conversationId,
                  null, // no checkpoint
                  retryCtx.stored.blobStore,
                  retryCtx.images ?? [],
                );
                freshPayload.mcpTools = retryCtx.mcpTools;
                effectiveRequestBytes = freshPayload.requestBytes;
                liveRequestBytes = effectiveRequestBytes;
              }

              log.warn(
                `[proxy] Empty stream close; retrying in ${delay}ms (attempt ${attempt + 1}/${maxConnectRetries + 1}, code=${code}, pressure=${pressureMode}, checkpointCleared=${isRetryAfterEmpty && !!retryCtx?.stored})`,
              );
              setTimeout(() => {
                if (closed) return;
                const { bridge: retryBridge, heartbeatTimer: retryTimer } =
                  startBridge(retryAccessToken, effectiveRequestBytes);
                runAttempt(retryBridge, retryTimer, attemptBlobStore, attemptMcpTools, attempt + 1);
              }, delay);
              return;
            }
          }

          const active = activeBridges.get(bridgeKey);
          const currentAttemptIsActive = active?.bridge === attemptBridge;

          if (!mcpExecReceived) {
            // If no visible content was ever sent, surface an explicit error instead of
            // a silent empty completion that looks like "instant empty reply" in Discord.
            if (!anyVisibleTextSent) {
              log.warn(`[proxy] All retries exhausted; sending empty-stream error (bridgeKey=${bridgeKey})`);
              sendSSE(makeChunk({ content: "\n[Error: Cursor returned empty response. Try sending your message again.]" }));
            }
            finishStream("stop");
            // Clean up bridge so h2-bridge subprocess can exit.
            clearInterval(attemptHeartbeat);
            attemptBridge.kill();
            deleteActiveBridge(bridgeKey);
          } else {
            // Bridge closed after model finished a tool-calling turn.
            // Park (or no-op if debounce/abort already parked) so OpenCode can
            // execute tools and return mcpResults.
            if (closed || finishedNaturally) {
              return;
            }
            if (code === 0) {
              parkableToolAttempt = {
                bridge: attemptBridge,
                heartbeatTimer: attemptHeartbeat,
                blobStore: attemptBlobStore,
                mcpTools: attemptMcpTools,
                pendingExecs: state.pendingExecs,
              };
              if (!parkBridgeForToolCalls("bridge-close")) {
                sendSSE(makeChunk({ content: "\n[Error: bridge capacity reached, try again]" }));
                finishStream("stop");
                clearInterval(attemptHeartbeat);
                attemptBridge.kill();
              } else {
                finishStream("tool_calls");
              }
            } else {
              // Bridge died before we could hand tool calls to OpenCode.
              if (currentAttemptIsActive) {
                deleteActiveBridge(bridgeKey);
              }
              sendSSE(makeChunk({ content: "\n[Error: bridge connection lost]" }));
              finishStream("stop");
              clearInterval(attemptHeartbeat);
              attemptBridge.kill();
            }
          }
        });
      }

      // Kick off the first attempt
      runAttempt(bridge, heartbeatTimer, blobStore, mcpTools, 0);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

/** Spawn a bridge, send the initial request frame, and start heartbeat. */
function startBridge(
  accessToken: string,
  requestBytes: Uint8Array,
): { bridge: ReturnType<typeof spawnBridge> | BridgeHandle; heartbeatTimer: NodeJS.Timeout } {
  const bridge: ReturnType<typeof spawnBridge> | BridgeHandle = bridgePool
    ? bridgePool.acquire({
        accessToken,
        rpcPath: "/agent.v1.AgentService/Run",
        url: CURSOR_API_URL,
      })
    : spawnBridge({
        accessToken,
        rpcPath: "/agent.v1.AgentService/Run",
      });
  bridge.write(frameConnectMessage(requestBytes));
  // Heartbeats keep the H2 stream alive. Bridges awaiting tool results are
  // protected from eviction/culling by isAwaitingToolResults(), not by bumping
  // lastAccessMs — which avoids holding JS references that can stall CI tests.
  const heartbeatTimer = setInterval(() => bridge.write(makeHeartbeatBytes()), 5_000);
  return { bridge, heartbeatTimer };
}

function handleStreamingResponse(
  payload: CursorRequestPayload,
  accessToken: string,
  modelId: string,
  bridgeKey: string,
  convKey: string,
  release: () => void,
  retryCtx?: RetryContext,
  workspaceRoot?: string,
  toolsDisabled: boolean = false,
  abortSignal?: AbortSignal,
): Response {
  const { bridge, heartbeatTimer } = startBridge(accessToken, payload.requestBytes);
  return createBridgeStreamResponse(
    bridge, heartbeatTimer,
    payload.blobStore, payload.mcpTools,
    modelId, bridgeKey, convKey, release,
    retryCtx,
    accessToken,
    payload.requestBytes,
    workspaceRoot,
    undefined,
    true,
    undefined,
    toolsDisabled,
    abortSignal,
  );
}
/** Resume a paused bridge by sending MCP results and continuing to stream. */
function handleToolResultResume(
  active: ActiveBridge,
  toolResults: ToolResultInfo[],
  modelId: string,
  bridgeKey: string,
  convKey: string,
  release: () => void,
  workspaceRoot?: string,
  abortSignal?: AbortSignal,
): Response {
  const { bridge, heartbeatTimer, blobStore, mcpTools, pendingExecs } = active;
  active.lastAccessMs = Date.now();

  // Send mcpResult for each pending exec that has a matching tool result.
  // Unmatched pending execs get an explicit error so Cursor does not hang
  // waiting for mcpResults that will never arrive (OpenCode returns full batches).
  for (const exec of pendingExecs) {
    const result = toolResults.find(
      (r) => r.toolCallId === exec.toolCallId,
    );
    let resultText = "";
    if (result) {
      // Truncate before Cursor sees it — multi-MB vite/build logs have stalled
      // the H2 resume path and left OpenCode with unsettled idle tools.
      const truncated = truncateToolResultForCursor(result.content);
      if (truncated.length < result.content.length) {
        log.warn(
          `[proxy] truncated mcpResult tool=${exec.toolName} from=${result.content.length} to=${truncated.length} bridgeKey=${bridgeKey}`,
        );
      }
      resultText = truncated;
    }
    const mcpResult = result
      ? create(McpResultSchema, {
          result: {
            case: "success",
            value: create(McpSuccessSchema, {
              content: [
                create(McpToolResultContentItemSchema, {
                  content: {
                    case: "text",
                    value: create(McpTextContentSchema, { text: resultText }),
                  },
                }),
              ],
              isError: false,
            }),
          },
        })
      : create(McpResultSchema, {
          result: {
            case: "error",
            value: create(McpErrorSchema, { error: "Tool result not provided" }),
          },
        });

    const execClientMessage = create(ExecClientMessageSchema, {
      id: exec.execMsgId,
      execId: exec.execId,
      message: {
        case: "mcpResult" as any,
        value: mcpResult as any,
      },
    });

    const clientMessage = create(AgentClientMessageSchema, {
      message: { case: "execClientMessage", value: execClientMessage },
    });

    bridge.write(
      frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)),
    );
  }

  const postedToolResults = toolResults.map((r) => {
    const truncated = truncateToolResultForCursor(r.content);
    return truncated === r.content ? r : { ...r, content: truncated };
  });

  // Post-tool stalls must not replay the original Run bytes (mcpResults would
  // be lost). Instead createBridgeStreamResponse rebuilds from the checkpoint
  // and re-attaches these tool results as a continuation prompt.
  return createBridgeStreamResponse(
    bridge, heartbeatTimer,
    blobStore, mcpTools,
    modelId, bridgeKey, convKey, release,
    active.resumeRetryCtx,
    active.accessToken,
    active.requestBytes,
    workspaceRoot,
    STALL_TIMEOUT_POST_TOOL_MS,
    false,
    postedToolResults,
    false,
    abortSignal,
  );
}