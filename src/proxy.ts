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
  ClientHeartbeatSchema,
  ConversationActionSchema,
  ConversationStateStructureSchema,
  ConversationStepSchema,
  AgentConversationTurnStructureSchema,
  ConversationTurnStructureSchema,
  AssistantMessageSchema,
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
  McpToolResultContentItemSchema,
  ModelDetailsSchema,
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
  WriteRejectedSchema,
  WriteResultSchema,
  WriteShellStdinErrorSchema,
  WriteShellStdinResultSchema,
  type AgentServerMessage,
  type ConversationStateStructure,
  type ExecServerMessage,
  type KvServerMessage,
  type McpToolDefinition,
} from "./proto/agent_pb";
import { createHash } from "node:crypto";
import { resolve as pathResolve } from "node:path";
import { Mutex } from "./promise-queue";
import { BridgePool, type BridgeHandle } from "./bridge-pool";

const CURSOR_API_URL = process.env.CURSOR_API_URL ?? "https://api2.cursor.sh";
const CONNECT_END_STREAM_FLAG = 0b00000010;
const BRIDGE_PATH = pathResolve(import.meta.dir, "h2-bridge.mjs");
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** A single element in an OpenAI multi-part content array. */
interface ContentPart {
  type: string;
  text?: string;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | ContentPart[];
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

function shouldBlockTool(tool: OpenAIToolDef): boolean {
  return tool.function.name.trim().toLowerCase() === "task";
}

interface ChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: OpenAIToolDef[];
  tool_choice?: unknown;
  user?: string;
  metadata?: Record<string, unknown>;
  thread_id?: string;
  conversation_id?: string;
  session_id?: string;
}


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
}

const conversationStates = new Map<string, StoredConversation>();
const CONVERSATION_TTL_MS = 30 * 60 * 1000;
const MUTEX_TTL_MS = 30 * 60 * 1000;
const ACTIVE_BRIDGE_TTL_MS = Number(process.env.OPENCODE_CURSOR_ACTIVE_BRIDGE_TTL_MS ?? 90 * 1000);
const ADMISSION_BRIDGE_CULL_IDLE_MS = Number(process.env.OPENCODE_CURSOR_ADMISSION_BRIDGE_CULL_IDLE_MS ?? 30 * 1000);
const MAX_ACTIVE_BRIDGES = 24;
const MAX_CONVERSATION_BLOB_BYTES = Number(process.env.OPENCODE_CURSOR_MAX_CONV_BLOB_BYTES ?? 64 * 1024 * 1024);
const MAX_CONVERSATION_BLOB_ENTRIES = Number(process.env.OPENCODE_CURSOR_MAX_CONV_BLOB_ENTRIES ?? 4096);
const MAX_LIVE_BRIDGE_BLOB_BYTES = Number(process.env.OPENCODE_CURSOR_MAX_BRIDGE_BLOB_BYTES ?? 128 * 1024 * 1024);
const MAX_LIVE_BRIDGE_BLOB_ENTRIES = Number(process.env.OPENCODE_CURSOR_MAX_BRIDGE_BLOB_ENTRIES ?? 8192);
const MAX_TOTAL_CONVERSATION_BLOB_BYTES = Number(process.env.OPENCODE_CURSOR_MAX_TOTAL_CONV_BLOB_BYTES ?? 256 * 1024 * 1024);
const PROXY_IDLE_SHUTDOWN_MS = 10 * 60 * 1000;
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
let idleShutdownTimer: ReturnType<typeof setTimeout> | undefined;
let maintenanceTimer: ReturnType<typeof setInterval> | undefined;

const proxyTelemetry = {
  capRejects: 0,
  staleConversationEvictions: 0,
  staleMutexEvictions: 0,
  staleBridgeEvictions: 0,
  forcedBridgeKills: 0,
  pressureActivations: 0,
  admissionRejects: 0,
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
    scheduleIdleShutdown();
  }
}

function killActiveBridge(active: ActiveBridge): void {
  proxyTelemetry.forcedBridgeKills += 1;
  clearInterval(active.heartbeatTimer);
  active.bridge.kill();
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
    console.warn(`[proxy] active bridge cap reached (${MAX_ACTIVE_BRIDGES}), rejecting new bridge`);
    killActiveBridge(active);
    return false;
  }
  active.lastAccessMs = Date.now();
  activeBridges.set(bridgeKey, active);
  return true;
}

/**
 * Wrap a Response so we can detect when its body stream is fully consumed.
 * Returns the wrapped response (identical to the client) and a `done` promise
 * that resolves when the stream finishes (success, error, or cancellation).
 */
function trackResponseCompletion(response: Response): {
  response: Response;
  done: Promise<void>;
} {
  if (!response.body) {
    return { response, done: Promise.resolve() };
  }

  const { promise, resolve } = Promise.withResolvers<void>();
  const { readable, writable } = new TransformStream();

  // Pipe the original body through; resolve when done (success or error).
  response.body.pipeTo(writable).then(resolve, resolve);

  return {
    response: new Response(readable, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    done: promise,
  };
} // 30 minutes

function evictStaleConversations(): number {
  let evicted = 0;
  const now = Date.now();
  for (const [key, stored] of conversationStates) {
    if (now - stored.lastAccessMs > CONVERSATION_TTL_MS) {
      conversationStates.delete(key);
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

function evictStaleActiveBridges(): number {
  let evicted = 0;
  const now = Date.now();
  for (const [bridgeKey, active] of activeBridges) {
    if (now - active.lastAccessMs > ACTIVE_BRIDGE_TTL_MS) {
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
    console.log(
      `[proxy] health activeReq=${activeRequestCount} activeBridges=${activeBridges.size} conv=${conversationStates.size} mutex=${convMutexes.size} ` +
      `evict(conv/mutex/bridge)=${proxyTelemetry.staleConversationEvictions}/${proxyTelemetry.staleMutexEvictions}/${proxyTelemetry.staleBridgeEvictions} ` +
      `capRejects=${proxyTelemetry.capRejects} admissionRejects=${proxyTelemetry.admissionRejects} bridgeKills=${proxyTelemetry.forcedBridgeKills} pressureHits=${proxyTelemetry.pressureActivations}` +
      poolInfo,
    );
  }
}

function clearIdleShutdownTimer(): void {
  if (!idleShutdownTimer) return;
  clearTimeout(idleShutdownTimer);
  idleShutdownTimer = undefined;
}

function scheduleIdleShutdown(): void {
  // Idle shutdown disabled — the proxy must stay alive as long as the opencode
  // process is running.  Previously, after 10 min idle the proxy would stop()
  // and the port would become invalid, but opencode's provider config still
  // referenced the dead port → ConnectionRefused on every subsequent request.
  // The maintenance sweep + admission control are sufficient for resource mgmt.
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
  /** When true, use application/proto for unary RPCs instead of Connect streaming. */
  unary?: boolean;
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
    unary: options.unary ?? false,
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

interface CursorUnaryRpcOptions {
  accessToken: string;
  rpcPath: string;
  requestBody: Uint8Array;
  url?: string;
  timeoutMs?: number;
}

export async function callCursorUnaryRpc(
  options: CursorUnaryRpcOptions,
 ): Promise<{ body: Uint8Array; exitCode: number; timedOut: boolean }> {
  const bridge = spawnBridge({
    accessToken: options.accessToken,
    rpcPath: options.rpcPath,
    url: options.url,
    unary: true,
  });
  const chunks: Buffer[] = [];
  const { promise, resolve } = Promise.withResolvers<{
    body: Uint8Array;
    exitCode: number;
    timedOut: boolean;
  }>();
  let timedOut = false;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const timeout = timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true;
        try { bridge.proc.kill(); } catch {}
      }, timeoutMs)
    : undefined;

  bridge.onData((chunk) => {
    chunks.push(Buffer.from(chunk));
  });
  bridge.onClose((exitCode) => {
    if (timeout) clearTimeout(timeout);
    resolve({
      body: Buffer.concat(chunks),
      exitCode,
      timedOut,
    });
  });

  // Unary: send raw protobuf body (no Connect framing)
  bridge.write(options.requestBody);
  bridge.end();

  return promise;
}

let proxyServer: ReturnType<typeof Bun.serve> | undefined;
let proxyPort: number | undefined;
let proxyAccessTokenProvider: (() => Promise<string>) | undefined;
let proxyModels: Array<{ id: string; name: string }> = [];

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
  clearIdleShutdownTimer();
  if (proxyServer && proxyPort) return proxyPort;

  // Initialize bridge pool for connection reuse
  if (BRIDGE_POOL_ENABLED && !bridgePool) {
    bridgePool = new BridgePool({
      minSize: BRIDGE_POOL_MIN_SIZE,
      maxSize: BRIDGE_POOL_MAX_SIZE,
    });
    bridgePool.warmup();
    console.log(`[proxy] bridge pool started min=${BRIDGE_POOL_MIN_SIZE} max=${BRIDGE_POOL_MAX_SIZE}`);
  }

  proxyServer = Bun.serve({
    port: 0,
    idleTimeout: 255, // max — Cursor responses can take 30s+
    async fetch(req) {
      activeRequestCount += 1;
      clearIdleShutdownTimer();
      try {
        const url = new URL(req.url);

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
          // Run maintenance before admission checks so stale bridges don't cause
          // false saturation.
          runMaintenanceSweep();
          if (activeBridges.size >= ADMISSION_MAX_ACTIVE_BRIDGES) {
            const culled = cullOldestIdleBridgesForAdmission(ADMISSION_MAX_ACTIVE_BRIDGES);
            if (culled > 0) {
              console.warn(`[proxy] admission preflight culled idle bridges=${culled}`);
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
          let release: (() => void) | undefined;
          try {
            const body = (await req.json()) as ChatCompletionRequest;
            const msgSummary = body.messages.map((m) => `${m.role}[${(typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.length + ' parts' : 'null')?.slice(0, 40)}]`).join(', ');
            console.log(`[proxy] REQUEST model=${body.model} stream=${body.stream} msgs=${body.messages.length} [${msgSummary.slice(0, 120)}]`);
            if (!proxyAccessTokenProvider) {
              throw new Error("Cursor proxy access token provider not configured");
            }
            const accessToken = await proxyAccessTokenProvider();

            // Serialize per-conversation requests to prevent race conditions
            // that cause "Blob not found" errors from concurrent state mutations.
            const convKey = deriveConversationKey(body);
            const mutex = getOrCreateMutex(convKey);
            const acquired = await mutex.acquire();
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
            const rawResponse = handleChatCompletion(body, accessToken, release);
            const resolvedResponse =
              rawResponse instanceof Promise ? await rawResponse : rawResponse;
            return resolvedResponse;
          } catch (err) {
            release?.();
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
        scheduleIdleShutdown();
      }
    },
  });

  maintenanceTimer = setInterval(runMaintenanceSweep, MAINTENANCE_INTERVAL_MS);

  proxyPort = proxyServer.port;
  if (!proxyPort) throw new Error("Failed to bind proxy to a port");
  return proxyPort;
}

export function stopProxy(): void {
  clearIdleShutdownTimer();
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
    proxyPort = undefined;
    proxyAccessTokenProvider = undefined;
    proxyModels = [];
  }
  // Clean up any lingering bridges
  for (const active of activeBridges.values()) {
    killActiveBridge(active);
  }
  activeBridges.clear();
  conversationStates.clear();
  convMutexes.clear();
  convMutexLastUsedMs.clear();
  systemBlobCache.clear();
  activeRequestCount = 0;
  proxyTelemetry.lastSnapshotMs = 0;
}

function handleChatCompletion(
  body: ChatCompletionRequest,
  accessToken: string,
  release: () => void,
): Response | Promise<Response> {
  return doHandleChatCompletion(body, accessToken, release);
}

async function doHandleChatCompletion(
  body: ChatCompletionRequest,
  accessToken: string,
  release: () => void,
): Promise<Response> {
  const { systemPrompt, userText, turns, toolResults } = parseMessages(body.messages);
  const modelId = body.model;
  const tools = (body.tools ?? []).filter((tool) => !shouldBlockTool(tool));

  if (!userText && toolResults.length === 0) {
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

  // Title-generation requests are stateless one-shot calls — they don't need
  // conversation state, checkpoints, MCP tools, or mutexes.  Bypass all of
  // that and stream directly to Cursor.
  const isTitleGen = isTitleGenerationRequest(body.messages);
  if (isTitleGen) {
    console.log(`[proxy] title-gen request model=${modelId} — stateless path`);
    const payload = buildCursorRequest(modelId, systemPrompt, userText, [], "", null, new Map());
    payload.mcpTools = [];
    const { bridge: tBridge, heartbeatTimer: tHb } = startBridge(accessToken, payload.requestBytes);
    return createBridgeStreamResponse(
      tBridge, tHb,
      payload.blobStore,
      [],
      modelId,
      `title:${crypto.randomUUID()}`,
      `title:${crypto.randomUUID()}`,
      release,
    );
  }

  // bridgeKey: model-specific, for active tool-call bridges
  // convKey: model-independent, for conversation state that survives model switches
  const bridgeKey = deriveBridgeKey(modelId, body);
  const convKey = deriveConversationKey(body);
  const prevStored = conversationStates.get(convKey);
  console.log(`[proxy] keys convKey=${convKey} bridgeKey=${bridgeKey} hasStored=${!!prevStored} hasCheckpoint=${!!prevStored?.checkpoint} turns=${turns.length} toolResults=${toolResults.length}`);

  // Mutex is already held by the fetch() handler — no need to acquire here.

  const activeBridge = activeBridges.get(bridgeKey);
  if (activeBridge) {
    activeBridge.lastAccessMs = Date.now();
  }

  if (activeBridge && toolResults.length > 0) {
    deleteActiveBridge(bridgeKey);

    if (activeBridge.bridge.alive) {
      // Resume the live bridge with tool results
      return handleToolResultResume(activeBridge, toolResults, modelId, bridgeKey, convKey, release);
    }

    // Bridge died (timeout, server disconnect, etc.).
    // Clean up and fall through to start a fresh bridge.
    killActiveBridge(activeBridge);
  }

  // Clean up stale bridge if present
  if (activeBridge && activeBridges.has(bridgeKey)) {
    killActiveBridge(activeBridge);
    deleteActiveBridge(bridgeKey);
  }

  let stored: StoredConversation | undefined = conversationStates.get(convKey);
  // Safety: if existing state has a checkpoint but this request has no conversation
  // history (no turns, no tool results), it's likely a key collision with a different
  // conversation type (e.g., title generation vs. regular chat). Reset to avoid
  // "Blob not found" errors from stale checkpoint references.
  if (stored?.checkpoint && turns.length === 0 && toolResults.length === 0) {
    conversationStates.delete(convKey);
    stored = undefined;
  }
  if (!stored) {
    stored = {
      conversationId: deterministicConversationId(convKey),
      checkpoint: null,
      blobStore: new Map(),
      lastAccessMs: Date.now(),
    };
    conversationStates.set(convKey, stored);
  }
  stored.lastAccessMs = Date.now();
  runMaintenanceSweep();

  // Build the request. When tool results are present but the bridge died,
  // we must still include the last user text so Cursor has context.
  const mcpTools = buildMcpToolDefinitions(tools);
  let effectiveUserText = userText || (toolResults.length > 0
    ? toolResults.map((r) => r.content).join("\n")
    : "");

  // For fresh conversations (no checkpoint), embed prior conversation turns
  // into the user message so the model has context of previous interactions.
  // When a checkpoint exists, Cursor already has the full conversation state.
  if (!stored.checkpoint && turns.length > 0) {
    const historyLines: string[] = [];
    for (const turn of turns) {
      if (turn.userText) historyLines.push(`User: ${turn.userText}`);
      if (turn.assistantText) historyLines.push(`Assistant: ${turn.assistantText}`);
    }
    if (historyLines.length > 0) {
      effectiveUserText = `[Previous conversation]\n${historyLines.join('\n')}\n\n[Current message]\n${effectiveUserText}`;
      console.log(`[proxy] embedded ${turns.length} prior turns in UserMessage (no checkpoint)`);
    }
  }

  const payload = buildCursorRequest(
    modelId, systemPrompt, effectiveUserText, turns,
    stored.conversationId, stored.checkpoint, stored.blobStore,
  );
  payload.mcpTools = mcpTools;

  if (body.stream === false) {
    return handleNonStreamingResponse(payload, accessToken, modelId, convKey, release);
  }
  const retryCtx: RetryContext = {
    stored,
    accessToken,
    modelId,
    systemPrompt,
    effectiveUserText,
    turns,
    mcpTools,
  };
  return handleStreamingResponse(
    payload, accessToken, modelId, bridgeKey, convKey, release,
    retryCtx,
  );
}

interface ToolResultInfo {
  toolCallId: string;
  content: string;
}

interface ParsedMessages {
  systemPrompt: string;
  userText: string;
  turns: Array<{ userText: string; assistantText: string }>;
  toolResults: ToolResultInfo[];
}

/** Normalize OpenAI message content to a plain string. */
function textContent(content: OpenAIMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!)
    .join("\n");
}

function parseMessages(messages: OpenAIMessage[]): ParsedMessages {
  let systemPrompt = "You are a helpful assistant.";
  const pairs: Array<{ userText: string; assistantText: string }> = [];
  const toolResults: ToolResultInfo[] = [];

  // Collect system messages
  const systemParts = messages
    .filter((m) => m.role === "system")
    .map((m) => textContent(m.content));
  if (systemParts.length > 0) {
    systemPrompt = systemParts.join("\n");
  }

  // Separate tool results from conversation turns.
  // OpenAI tool-call pattern interleaves assistant(tool_calls) → tool → assistant(text):
  //   user → assistant(tool_calls) → tool → assistant(text+tool_calls) → tool → assistant(text) → user
  // We accumulate ALL assistant text after each user message until the next user message,
  // so each turn pair captures the full assistant response across tool-call cycles.
  const nonSystem = messages.filter((m) => m.role !== "system");
  let pendingUser = "";
  let pendingAssistantTexts: string[] = [];

  function flushPair() {
    if (pendingUser) {
      pairs.push({
        userText: pendingUser,
        assistantText: pendingAssistantTexts.join("\n"),
      });
    }
    pendingUser = "";
    pendingAssistantTexts = [];
  }

  for (const msg of nonSystem) {
    if (msg.role === "tool") {
      toolResults.push({
        toolCallId: msg.tool_call_id ?? "",
        content: textContent(msg.content),
      });
    } else if (msg.role === "user") {
      flushPair();
      pendingUser = textContent(msg.content);
    } else if (msg.role === "assistant") {
      const text = textContent(msg.content);
      if (text) {
        pendingAssistantTexts.push(text);
      }
    }
  }

  // If accumulated assistant text for pending user, it's a completed turn
  if (pendingUser && pendingAssistantTexts.length > 0) {
    pairs.push({
      userText: pendingUser,
      assistantText: pendingAssistantTexts.join("\n"),
    });
    pendingUser = "";
  }

  // Determine the current user message to send to Cursor
  let lastUserText = "";
  if (pendingUser) {
    lastUserText = pendingUser;
  } else if (pairs.length > 0 && toolResults.length === 0) {
    const last = pairs.pop()!;
    lastUserText = last.userText;
  }

  return { systemPrompt, userText: lastUserText, turns: pairs, toolResults };
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
  modelId: string,
  systemPrompt: string,
  userText: string,
  turns: Array<{ userText: string; assistantText: string }>,
  conversationId: string,
  checkpoint: Uint8Array | null,
  existingBlobStore?: Map<string, Uint8Array>,
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

  const userMessage = create(UserMessageSchema, {
    text: userText,
    messageId: crypto.randomUUID(),
  });

  // Store the user message protobuf in blobStore so Cursor can look it up via getBlob.
  // Cursor uses the raw protobuf bytes as the blob ID (not a hash).
  const userMsgBytes = toBinary(UserMessageSchema, userMessage);
  const userMsgBlobId = Buffer.from(userMsgBytes).toString("hex");
  blobStore.set(userMsgBlobId, userMsgBytes);

  const action = create(ConversationActionSchema, {
    action: {
      case: "userMessageAction",
      value: create(UserMessageActionSchema, { userMessage }),
    },
  });

  const modelDetails = create(ModelDetailsSchema, {
    modelId,
    displayModelId: modelId,
    displayName: modelId,
  });

  const runRequest = create(AgentRunRequestSchema, {
    conversationState,
    action,
    modelDetails,
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
            const fieldNum = tag >> 3;
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
  outputTokens: number;
  totalTokens: number;
}

function computeUsage(state: StreamState) {
  const completion_tokens = state.outputTokens;
  const total_tokens = state.totalTokens || completion_tokens;
  const prompt_tokens = Math.max(0, total_tokens - completion_tokens);
  return { prompt_tokens, completion_tokens, total_tokens };
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
    );
  } else if (msgCase === "conversationCheckpointUpdate") {
    const stateStructure = msg.message.value as ConversationStateStructure;
    if (stateStructure.tokenDetails) {
      state.totalTokens = stateStructure.tokenDetails.usedTokens;
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
      console.warn(`[proxy] getBlob MISS: ${blobIdKey.slice(0, 16)}... (store has ${blobStore.size} entries)`);
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
): void {
  const execCase = execMsg.message.case;

  if (execCase === "requestContextArgs") {
    const MCP_ONLY_RULE = "CRITICAL: Do NOT use native tools (read, ls, grep, shell, write, delete, fetch, diagnostics, backgroundShellSpawn, writeShellStdin). They are ALL disabled in this environment. Use ONLY the MCP tools provided in the tools list. Every native tool call will be rejected and waste time. Always use MCP tools for all file operations, shell commands, searches, and any other actions.";

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
      tools: mcpTools,
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
    const mcpArgs = execMsg.message.value;
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
      toolName: mcpArgs.toolName || mcpArgs.name,
      decodedArgs: JSON.stringify(decoded),
    });
    return;
  }

  // --- Reject native Cursor tools ---
  // The model tries these first. We must respond with rejection/error
  // so it falls back to our MCP tools (registered via RequestContext).
  const REJECT_REASON = "Tool not available in this environment. Use the MCP tools provided instead.";

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
  console.error(`[proxy] unhandled exec: ${execCase}`);
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

function buildConversationIdentity(body: ChatCompletionRequest): string {
  const rawIds = [
    body.conversation_id,
    body.thread_id,
    body.session_id,
    body.user,
  ];
  for (const id of rawIds) {
    if (typeof id === "string" && id.trim().length > 0) {
      return `id:${id.trim()}`;
    }
  }

  const metadata = body.metadata && typeof body.metadata === "object"
    ? body.metadata
    : undefined;
  if (metadata) {
    const candidateKeys = ["conversation_id", "thread_id", "session_id", "chat_id", "id"];
    for (const key of candidateKeys) {
      const value = metadata[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return `meta:${key}:${value.trim()}`;
      }
    }
  }

  return "";
}

/** Derive a key for active bridge lookup (tool-call continuations). Model-specific. */
function deriveBridgeKey(modelId: string, body: ChatCompletionRequest): string {
  const identity = buildConversationIdentity(body);
  const firstUserMsg = body.messages.find((m) => m.role === "user");
  const firstUserText = firstUserMsg ? textContent(firstUserMsg.content) : "";
  const titleNs = isTitleGenerationRequest(body.messages) ? "title:" : "";
  const base = identity || `fallback:${titleNs}${firstUserText}`;
  return createHash("sha256")
    .update(`bridge:${modelId}:${base}`)
    .digest("hex")
    .slice(0, 24);
}

/** Detect if this is a title generation request by checking for title-gen system prompt. */
function isTitleGenerationRequest(messages: OpenAIMessage[]): boolean {
  const systemText = messages
    .filter((m) => m.role === "system")
    .map((m) => textContent(m.content))
    .join(" ");
  return systemText.toLowerCase().includes("title generator") ||
         systemText.toLowerCase().includes("generate a short title");
}

/** Derive a key for conversation state. Model-independent so context survives model switches.
 *
 * Priority:
 * 1) Explicit conversation identity passed by caller (conversation/thread/session/user)
 * 2) Fallback hash from stable message anchors (system + first user text)
 */
function deriveConversationKey(body: ChatCompletionRequest): string {
  const identity = buildConversationIdentity(body);
  const firstUserMsg = body.messages.find((m) => m.role === "user");
  const firstUserText = firstUserMsg ? textContent(firstUserMsg.content) : "";
  const titleNs = isTitleGenerationRequest(body.messages) ? "title:" : "";
  // NOTE: Do NOT include full system prompt in fallback key — OpenCode's system
  // prompt changes every request (dynamic context, per-turn metadata), which would
  // cause convKey to rotate and lose the stored conversation checkpoint.
  // Only firstUserText is used — it's the stable initial user message.
  const fallbackSeed = `${titleNs}user:${firstUserText}`;
  const seed = identity || `fallback:${fallbackSeed}`;
  return createHash("sha256")
    .update(`conv:${seed}`)
    .digest("hex")
    .slice(0, 24);
}

/** Deterministic UUID derived from convKey so Cursor's server-side conversation
 *  persists across proxy restarts. Formats 16 bytes of SHA-256 as a v4-shaped UUID. */
function deterministicConversationId(convKey: string): string {
  const hex = createHash("sha256")
    .update(`cursor-conv-id:${convKey}`)
    .digest("hex")
    .slice(0, 32);
  // Format as UUID: xxxxxxxx-xxxx-4xxx-Nxxx-xxxxxxxxxxxx
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${(0x8 | (parseInt(hex[16], 16) & 0x3)).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

/** Context for retrying a streaming request after "Blob not found" errors. */
interface RetryContext {
  stored: StoredConversation;
  accessToken: string;
  modelId: string;
  systemPrompt: string;
  effectiveUserText: string;
  turns: Array<{ userText: string; assistantText: string }>;
  mcpTools: McpToolDefinition[];
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
): Response {
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

  const stream = new ReadableStream({
    cancel() {
      cleanupCurrentAttempt();
      safeRelease();
    },
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const sendSSE = (data: object) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };
      const sendDone = () => {
        if (closed) return;
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      };
      const closeController = () => {
        if (closed) return;
        closed = true;
        controller.close();
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
          totalTokens: 0,
        };
        const tagFilter = createThinkingTagFilter();
        let mcpExecReceived = false;
        let anyContentSent = false;
        let blobNotFound = false;
        let connectError = false;
        const pressureMode = isProxyUnderPressure();
        if (pressureMode) {
          proxyTelemetry.pressureActivations += 1;
        }
        const maxConnectRetries = pressureMode ? PRESSURE_MAX_CONNECT_RETRIES : MAX_CONNECT_RETRIES;
        const retryDelayMultiplier = pressureMode ? PRESSURE_RETRY_DELAY_MULTIPLIER : 1;

        const makeUsageChunk = () => {
          const { prompt_tokens, completion_tokens, total_tokens } = computeUsage(state);
          return {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model: modelId,
            choices: [],
            usage: { prompt_tokens, completion_tokens, total_tokens },
          };
        };

        const processChunk = createConnectFrameParser(
          (messageBytes) => {
            try {
              const serverMessage = fromBinary(
                AgentServerMessageSchema,
                messageBytes,
              );
              processServerMessage(
                serverMessage,
                attemptBlobStore,
                attemptMcpTools,
                (data) => attemptBridge.write(data),
                state,
                (text, isThinking) => {
                  anyContentSent = true;
                  if (isThinking) {
                    sendSSE(makeChunk({ reasoning_content: text }));
                  } else {
                    const { content, reasoning } = tagFilter.process(text);
                    if (reasoning) sendSSE(makeChunk({ reasoning_content: reasoning }));
                    if (content) sendSSE(makeChunk({ content }));
                  }
                },
                // onMcpExec — the model wants to execute a tool.
                (exec) => {
                  state.pendingExecs.push(exec);
                  mcpExecReceived = true;
                  anyContentSent = true;

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

                  // Keep the bridge alive for tool result continuation.
                  const attached = setActiveBridge(bridgeKey, {
                    bridge: attemptBridge,
                    heartbeatTimer: attemptHeartbeat,
                    blobStore: attemptBlobStore,
                    mcpTools: attemptMcpTools,
                    pendingExecs: state.pendingExecs,
                    lastAccessMs: Date.now(),
                  });
                  if (!attached) {
                    sendSSE(makeChunk({ content: "\n[Error: bridge capacity reached, try again]" }));
                    sendSSE(makeChunk({}, "stop"));
                    sendDone();
                    closeController();
                    return;
                  }

                  sendSSE(makeChunk({}, "tool_calls"));
                  sendDone();
                  closeController();
                },
                (checkpointBytes) => {
                  const stored = conversationStates.get(convKey);
                  if (stored) {
                    stored.checkpoint = checkpointBytes;
                    for (const [k, v] of attemptBlobStore) stored.blobStore.set(k, v);
                    enforceConversationBlobBudget(stored);
                    stored.lastAccessMs = Date.now();
                  }
                },
              );
            } catch {
              // Skip unparseable messages
            }
          },
          (endStreamBytes) => {
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
              // Auto-retry on transient connect errors (e.g. "invalid_argument")
              // if no content was emitted and we haven't exhausted retries.
              if (
                !anyContentSent &&
                !blobNotFound &&
                attempt < maxConnectRetries &&
                accessToken &&
                requestBytes
              ) {
                connectError = true;
                console.warn(`[proxy] Connect error (attempt ${attempt + 1}/${maxConnectRetries + 1}, pressure=${pressureMode}): ${endError.message}`);
                return; // swallow error — onClose will retry
              }
              anyContentSent = true;
              sendSSE(makeChunk({ content: `\n[Error: ${endError.message}]` }));
            }
          },
        );

        attemptBridge.onData(processChunk);

        attemptBridge.onClose((code) => {
          clearInterval(attemptHeartbeat);
          const stored = conversationStates.get(convKey);
          if (stored) {
            for (const [k, v] of attemptBlobStore) stored.blobStore.set(k, v);
            enforceConversationBlobBudget(stored);
            stored.lastAccessMs = Date.now();
          }

          // Retry: clear stale checkpoint and start a fresh bridge
          if (blobNotFound && !anyContentSent && attempt === 0 && retryCtx) {
            console.warn("[proxy] Blob not found, retrying without checkpoint");
            if (stored) {
              stored.checkpoint = null;
              stored.blobStore.clear();
            }
            deleteActiveBridge(bridgeKey);
            attemptBridge.kill();

            const freshPayload = buildCursorRequest(
              retryCtx.modelId,
              retryCtx.systemPrompt,
              retryCtx.effectiveUserText,
              retryCtx.turns,
              retryCtx.stored.conversationId,
              null, // no checkpoint
              retryCtx.stored.blobStore,
            );
            freshPayload.mcpTools = retryCtx.mcpTools;
            const { bridge: newBridge, heartbeatTimer: newTimer } =
              startBridge(retryCtx.accessToken, freshPayload.requestBytes);
            runAttempt(newBridge, newTimer, freshPayload.blobStore, freshPayload.mcpTools, 1);
            return;
          }

          // Retry on transient connect errors with exponential backoff.
          // The setTimeout is scoped inside the ReadableStream — if the client
          // aborts (kimaki abort), the stream closes and safeRelease fires,
          // so no further retries will execute.
          if (connectError && !anyContentSent && attempt < maxConnectRetries && accessToken && requestBytes) {
            deleteActiveBridge(bridgeKey);
            attemptBridge.kill();
            const delay = CONNECT_RETRY_BASE_DELAY_MS * retryDelayMultiplier * Math.pow(2, attempt);
            console.warn(`[proxy] Retrying connect in ${delay}ms (attempt ${attempt + 1}/${maxConnectRetries + 1}, pressure=${pressureMode})`);
            setTimeout(() => {
              // If the stream was already closed (client abort), don't retry.
              if (closed) return;
              const { bridge: retryBridge, heartbeatTimer: retryTimer } =
                startBridge(accessToken, requestBytes);
              runAttempt(retryBridge, retryTimer, attemptBlobStore, attemptMcpTools, attempt + 1);
            }, delay);
            return;
          }

          const active = activeBridges.get(bridgeKey);
          const currentAttemptIsActive = active?.bridge === attemptBridge;

          if (!mcpExecReceived) {
            const flushed = tagFilter.flush();
            if (flushed.reasoning) sendSSE(makeChunk({ reasoning_content: flushed.reasoning }));
            if (flushed.content) sendSSE(makeChunk({ content: flushed.content }));
            sendSSE(makeChunk({}, "stop"));
            sendSSE(makeUsageChunk());
            sendDone();
            closeController();
            // Clean up bridge so h2-bridge subprocess can exit.
            clearInterval(attemptHeartbeat);
            attemptBridge.kill();
            deleteActiveBridge(bridgeKey);
          } else {
            // If a bridge closes while waiting for tool-results continuation,
            // always detach it from activeBridges to avoid stale saturation.
            if (currentAttemptIsActive) {
              deleteActiveBridge(bridgeKey);
            }
            if (code !== 0) {
              // Bridge died while tool calls are pending (timeout, crash, etc.).
              sendSSE(makeChunk({ content: "\n[Error: bridge connection lost]" }));
              sendSSE(makeChunk({}, "stop"));
              sendSSE(makeUsageChunk());
              sendDone();
              closeController();
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
      })
    : spawnBridge({
        accessToken,
        rpcPath: "/agent.v1.AgentService/Run",
      });
  bridge.write(frameConnectMessage(requestBytes));
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
): Response {
  const { bridge, heartbeatTimer } = startBridge(accessToken, payload.requestBytes);
  return createBridgeStreamResponse(
    bridge, heartbeatTimer,
    payload.blobStore, payload.mcpTools,
    modelId, bridgeKey, convKey, release,
    retryCtx,
    accessToken,
    payload.requestBytes,
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
): Response {
  const { bridge, heartbeatTimer, blobStore, mcpTools, pendingExecs } = active;
  active.lastAccessMs = Date.now();

  // Send mcpResult for each pending exec that has a matching tool result
  for (const exec of pendingExecs) {
    const result = toolResults.find(
      (r) => r.toolCallId === exec.toolCallId,
    );
    const mcpResult = result
      ? create(McpResultSchema, {
          result: {
            case: "success",
            value: create(McpSuccessSchema, {
              content: [
                create(McpToolResultContentItemSchema, {
                  content: {
                    case: "text",
                    value: create(McpTextContentSchema, { text: result.content }),
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

  return createBridgeStreamResponse(
    bridge, heartbeatTimer,
    blobStore, mcpTools,
    modelId, bridgeKey, convKey, release,
  );
}

async function handleNonStreamingResponse(
  payload: CursorRequestPayload,
  accessToken: string,
  modelId: string,
  convKey: string,
  release: () => void,
): Promise<Response> {
  const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 28)}`;
  const created = Math.floor(Date.now() / 1000);
  try {
    const { text, usage } = await collectFullResponse(payload, accessToken, convKey);
    return new Response(
      JSON.stringify({
        id: completionId,
        object: "chat.completion",
        created,
        model: modelId,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text },
            finish_reason: "stop",
          },
        ],
        usage,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } finally {
    release();
  }
}

interface CollectedResponse {
  text: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

async function collectFullResponse(
  payload: CursorRequestPayload,
  accessToken: string,
  convKey: string,
): Promise<CollectedResponse> {
  const { promise, resolve } = Promise.withResolvers<CollectedResponse>();
  let fullText = "";

  const { bridge, heartbeatTimer } = startBridge(accessToken, payload.requestBytes);

  const state: StreamState = {
    toolCallIndex: 0,
    pendingExecs: [],
    outputTokens: 0,
    totalTokens: 0,
  };
  const tagFilter = createThinkingTagFilter();

  bridge.onData(createConnectFrameParser(
    (messageBytes) => {
      try {
        const serverMessage = fromBinary(
          AgentServerMessageSchema,
          messageBytes,
        );
        processServerMessage(
          serverMessage,
          payload.blobStore,
          payload.mcpTools,
          (data) => bridge.write(data),
          state,
          (text, isThinking) => {
            if (isThinking) return;
            const { content } = tagFilter.process(text);
            fullText += content;
          },
          () => {},
          (checkpointBytes) => {
            const stored = conversationStates.get(convKey);
            if (stored) {
              stored.checkpoint = checkpointBytes;
              for (const [k, v] of payload.blobStore) stored.blobStore.set(k, v);
              enforceConversationBlobBudget(stored);
              stored.lastAccessMs = Date.now();
            }
          },
        );
      } catch {
        // Skip
      }
    },
    (endStreamBytes) => {
      const endError = parseConnectEndStream(endStreamBytes);
      if (endError) {
        fullText += `\n[Error: ${endError.message}]`;
      }
    },
  ));

  bridge.onClose(() => {
    clearInterval(heartbeatTimer);
    const stored = conversationStates.get(convKey);
    if (stored) {
      for (const [k, v] of payload.blobStore) stored.blobStore.set(k, v);
      enforceConversationBlobBudget(stored);
      stored.lastAccessMs = Date.now();
    }
    const flushed = tagFilter.flush();
    fullText += flushed.content;

    const usage = computeUsage(state);
    resolve({
      text: fullText,
      usage,
    });
  });

  return promise;
}
