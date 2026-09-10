import { createHash, randomUUID } from "node:crypto";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import * as p from "./proto/agent_pb.js";
import { CURSOR_API_URL } from "./cursor-rpc.js";
import { resolveNodeExecutable } from "./node-runtime.js";
import type { CursorModelSelection } from "./model-selection.js";
import type { CursorToolDefinition } from "./tools.js";
import {
  appendEntry,
  stableJson,
  type HistoryEntry,
  type HostToolResult,
  record,
  opaqueAnchorDigest,
  captureOpaqueReasoning,
  applyOpaqueReasoning,
} from "./opencode/history.js";
import {
  reasoningDigest,
  type ReasoningSignature,
  opaqueReasoning,
  type OpaqueReasoning,
} from "./opencode/reasoning.js";
import type { JsonObject, JsonValue } from "@bufbuild/protobuf";
import { buildAgentRequest, decodeArgs } from "./cursor-agent-protocol.js";
import { startAgentTransport } from "./cursor-agent-transport.js";
import type { HostToolObserver } from "./opencode/tool-observer.js";
import { readTurnUsage, type CursorTokenUsage } from "./cursor-agent-usage.js";

export type CursorRunEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; id: string }
  | { type: "reasoning-metadata"; signatures: ReasoningSignature[] }
  | { type: "opaque-reasoning"; annotations: OpaqueReasoning[] }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
  | {
      type: "finish";
      reason: "stop" | "tool-calls";
      outputTokenDelta?: number;
      /** Complete terminal counters for the disposable Cursor Run. */
      turnUsage?: CursorTokenUsage;
      contextTokens?: number;
    };

export interface CursorRunInput {
  accessToken: string;
  selection: CursorModelSelection;
  history: HistoryEntry[];
  results: HostToolResult[];
  tools: CursorToolDefinition[];
  scope: string;
  abortSignal?: AbortSignal;
  apiUrl?: string;
  host?: { sessionID: string; observer: HostToolObserver };
}

interface PendingCall {
  upstreamID: string;
  id: string;
  name: string;
  input: string;
  replies: { id: number; execId: string }[];
  status: "queued" | "delivered" | "forwarded";
  result?: HostToolResult;
  kind?: "mcp" | "shellStream" | "shell" | "grep" | "read" | "write" | "ls";
  rawArgs?: unknown;
}

const runs = new Map<string, AgentRun>();
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const setting = (key: string, fallback: number) => {
  const value = Number(process.env[key] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export function nativeOutputStallTimeoutMs(): number {
  return Number(process.env.OPENCODE_CURSOR_STALL_TIMEOUT_MS ?? 180_000);
}

/** Validate the required runtime; workers start lazily and own exactly one Run. */
export function startCursorTransport(): void {
  resolveNodeExecutable();
}
export function stopCursorTransport(scope?: string): void {
  for (const run of runs.values())
    if (
      scope === undefined ||
      run.scope === scope ||
      run.scope.startsWith(`${scope}:`)
    )
      run.dispose();
}
export function nativeCursorTransportStats() {
  return {
    contexts: runs.size,
    parked: [...runs.values()].filter((run) => run.parked).length,
    pendingToolCalls: [...runs.values()].reduce(
      (n, run) => n + run.pendingCount,
      0,
    ),
  };
}

export function runCursorAgent(
  input: CursorRunInput,
): ReadableStream<CursorRunEvent> {
  input.abortSignal?.throwIfAborted();
  // Resolve credentials before this call. Hashes are memory-only, never logged.
  const identity = hash(
    stableJson({
      credential: input.accessToken,
      endpoint: input.apiUrl ?? CURSOR_API_URL,
      selection: input.selection,
      tools: input.tools,
    }),
  );
  const candidates = [...runs.values()].filter(
    (run) => run.scope === input.scope && run.parked,
  );
  const existing = candidates.find((run) => run.canResume(identity, input));
  if (existing) return existing.resume(input);
  for (const run of candidates) run.dispose();
  const capacity = Math.max(
    1,
    Math.floor(setting("OPENCODE_CURSOR_MAX_ACTIVE_RUNS", 4)),
  );
  if (runs.size >= capacity) {
    const idle = [...runs.values()].find((run) => run.parked);
    idle?.dispose();
  }
  if (runs.size >= capacity)
    throw new Error(
      `Cursor AgentService capacity reached (${capacity} active Runs)`,
    );
  const run = new AgentRun(identity, input);
  runs.set(run.id, run);
  return run.open(input.abortSignal);
}

function extractToolOutput(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "output" in parsed) {
      if (typeof parsed.output === "string") return parsed.output;
      return typeof parsed.output === "object"
        ? stableJson(parsed.output)
        : String(parsed.output);
    }
  } catch {
    // not JSON envelope, use as-is
  }
  return raw;
}

class AgentRun {
  readonly id = randomUUID();
  readonly calls = new Map<string, PendingCall>();
  private readonly nativeEdits = new Set<string>();
  private readonly payload;
  private readonly nonce = randomUUID();
  private readonly transport;
  private expected: HistoryEntry[];
  private historyBytes: number;
  private controller?: ReadableStreamDefaultController<CursorRunEvent>;
  private queued: Exclude<CursorRunEvent, { type: "finish" }>[] = [];
  private queuedBytes = 0;
  private status: "active" | "parked" | "closed" = "active";
  private turnEnded = false;
  private outputTokens?: number;
  private usage?: CursorTokenUsage;
  private contextTokens?: number;
  private preDeltaContextTokens?: number;
  private sawTokenDelta = false;
  private checkpointSeenThisStep = false;
  private checkpointAfterTokenDelta = false;
  private traceCount = 0;
  private outputStarted = false;
  private resumed = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private stall?: ReturnType<typeof setTimeout>;
  private delivery?: ReturnType<typeof setTimeout>;
  private expiry?: ReturnType<typeof setTimeout>;
  private handoff?: ReturnType<typeof setTimeout>;
  private readonly watching = new Map<string, () => void>();
  private releaseSession?: () => void;
  private reasoningID?: string;
  private readonly reasoningBlocks = new Map<string, JsonObject>();
  private readonly signedRoots = new Map<
    string,
    { text: string; signature: string; modelName: string }[]
  >();
  private readonly checkpointRoots = new Set<string>();
  private readonly redactedRoots = new Map<string, JsonValue[]>();
  private readonly outputEntries = new Set<number>();
  private signal?: AbortSignal;
  private readonly abort = () =>
    this.dispose(
      this.signal?.reason ?? new DOMException("Aborted", "AbortError"),
    );

  constructor(
    private readonly identity: string,
    private readonly input: CursorRunInput,
  ) {
    this.expected = structuredClone(input.history);
    this.historyBytes = Buffer.byteLength(stableJson(input.history));
    this.payload = buildAgentRequest(
      input.selection,
      input.history,
      input.tools,
    );
    this.trace("Run opened", {
      model: input.selection.publicId,
      toolNames: input.tools.map((tool) => tool.function.name),
      historyEntries: input.history.length,
      historyBytes: this.historyBytes,
    });
    this.transport = startAgentTransport({
      accessToken: input.accessToken,
      url: input.apiUrl ?? CURSOR_API_URL,
      tools: input.tools.length > 0,
      onMessage: (bytes) => {
        try {
          this.receive(fromBinary(p.AgentServerMessageSchema, bytes));
        } catch (error) {
          this.dispose(
            error instanceof Error
              ? error
              : new Error("Invalid Cursor protocol message"),
          );
        }
      },
      onEnd: (error) => {
        if (this.status === "closed") return;
        if (error || !this.turnEnded)
          return this.dispose(
            error ?? new Error("Cursor Run ended without turnEnded"),
          );
        try {
          this.preserveOpaqueReasoning();
          this.finish("stop");
          this.dispose();
        } catch (error) {
          this.dispose(error);
        }
      },
    });
  }

  get parked() {
    return this.status === "parked";
  }
  private get tracing() {
    return process.env.OPENCODE_CURSOR_PROTOCOL_TRACE === "1";
  }
  private trace(event: string, details: Record<string, unknown>) {
    if (this.tracing && this.traceCount++ < 64)
      console.error(`[opencode-cursor] ${event}`, details);
  }
  get scope() {
    return this.input.scope;
  }
  get pendingCount() {
    return [...this.calls.values()].filter(
      (call) => call.status !== "forwarded",
    ).length;
  }

  open(signal?: AbortSignal): ReadableStream<CursorRunEvent> {
    const stream = this.attach(signal);
    if (this.status === "closed") return stream;
    try {
      this.releaseSession = this.input.host?.observer.watchSession(
        this.input.host.sessionID,
        () => {
          if (this.pendingCount) this.dispose();
        },
        (error) => this.dispose(error),
      );
      this.send(this.payload.message.message);
      this.heartbeat = setInterval(() => {
        try {
          this.send({
            case: "clientHeartbeat",
            value: create(p.ClientHeartbeatSchema),
          });
        } catch (error) {
          this.dispose(error);
        }
      }, 5_000);
    } catch (error) {
      this.dispose(error);
    }
    return stream;
  }

  canResume(identity: string, input: CursorRunInput): boolean {
    if (!this.parked || identity !== this.identity) return false;
    const expectedCalls = [...this.calls.values()].filter(
      (call) => call.status === "delivered",
    );
    const last = input.history.at(-1);
    if (!expectedCalls.length || last?.role !== "tool") return false;
    const prefix = input.history.slice(0, -1);
    if (stableJson(prefix) !== stableJson(this.expected)) return false;
    const ids = new Set(
      last.content.map((part) =>
        typeof part === "object" && part !== null && !Array.isArray(part)
          ? part.toolCallId
          : undefined,
      ),
    );
    return (
      ids.size === last.content.length &&
      ids.size === expectedCalls.length &&
      expectedCalls.every(
        (call) =>
          ids.has(call.id) &&
          input.results.some(
            (result) => result.id === call.id && result.name === call.name,
          ),
      )
    );
  }

  resume(input: CursorRunInput): ReadableStream<CursorRunEvent> {
    this.expected = structuredClone(input.history);
    for (const entry of this.expected)
      if (entry.role !== "system")
        for (const part of entry.content) {
          const block = record(part);
          if (
            typeof block?.cursorReasoningID === "string" &&
            this.reasoningBlocks.has(block.cursorReasoningID)
          )
            this.reasoningBlocks.set(
              block.cursorReasoningID,
              part as JsonObject,
            );
        }
    this.historyBytes = Buffer.byteLength(stableJson(input.history));
    this.resumed = true;
    const delivered = [...this.calls.values()].filter(
      (call) => call.status === "delivered",
    );
    const stream = this.attach(input.abortSignal);
    if (this.status === "closed") return stream;
    try {
      // The authoritative host checkpoint has happened. Only previously delivered
      // calls require results; queued late calls have never been shown to the host.
      for (const call of delivered) {
        call.result = input.results.find((result) => result.id === call.id)!;
        call.status = "forwarded";
        for (const reply of call.replies) this.replyResult(reply, call.result, call);
      }
      const queued = this.queued;
      this.queued = [];
      this.queuedBytes = 0;
      for (const event of queued) this.emit(event);
    } catch (error) {
      this.dispose(error);
    }
    return stream;
  }

  private attach(signal?: AbortSignal): ReadableStream<CursorRunEvent> {
    clearTimeout(this.expiry);
    this.signal?.removeEventListener("abort", this.abort);
    this.signal = signal;
    this.status = "active";
    this.outputStarted = false;
    this.sawTokenDelta = false;
    this.preDeltaContextTokens = undefined;
    this.checkpointSeenThisStep = false;
    this.checkpointAfterTokenDelta = false;
    return new ReadableStream<CursorRunEvent>(
      {
        start: (controller) => {
          this.controller = controller;
          if (signal?.aborted) return this.abort();
          signal?.addEventListener("abort", this.abort, { once: true });
          this.progress();
        },
        cancel: () => this.dispose(),
      },
      {
        highWaterMark: 8 * 1024 * 1024,
        size: (event) => Buffer.byteLength(stableJson(event)),
      },
    );
  }

  private emit(event: Exclude<CursorRunEvent, { type: "finish" }>) {
    if (this.status === "closed") return;
    if (this.parked) {
      this.queuedBytes += Buffer.byteLength(stableJson(event));
      if (this.queuedBytes > 8 * 1024 * 1024 || this.queued.length >= 4096)
        throw new Error("Cursor pending output capacity exceeded");
      this.queued.push(event);
      return;
    }
    if ((this.controller?.desiredSize ?? 0) <= 0)
      throw new Error("Cursor host stream capacity exceeded");
    this.historyBytes += Buffer.byteLength(stableJson(event));
    if (this.historyBytes > 128 * 1024 * 1024)
      throw new Error("Cursor continuation history capacity exceeded");
    if (event.type === "tool-call") {
      const call = [...this.calls.values()].find(
        (item) => item.id === event.toolCallId,
      )!;
      call.status = "delivered";
      appendEntry(this.expected, {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: call.id,
            toolName: call.name,
            args: JSON.parse(call.input),
          },
        ],
      });
      const host = this.input.host;
      if (host) {
        clearTimeout(this.delivery);
        this.delivery = undefined;
        this.watching.set(
          call.id,
          host.observer.watch(
            host.sessionID,
            call.id,
            () => {
              this.watching.delete(call.id);
              if (!this.watching.size) this.scheduleDelivery();
            },
            (error) => this.dispose(error),
          ),
        );
        // A finite retention bound, never an assertion of upstream batch completion.
        this.handoff ??= setTimeout(
          () => this.finish("tool-calls"),
          setting("OPENCODE_CURSOR_NATIVE_TOOL_WAIT_MS", 300_000),
        );
      } else this.scheduleDelivery();
    } else if (event.type === "opaque-reasoning") {
      applyOpaqueReasoning(this.expected, event.annotations);
    } else if (event.type === "reasoning-metadata") {
      for (const signature of event.signatures) {
        const block = this.reasoningBlocks.get(signature.id);
        if (!block || reasoningDigest(String(block.text)) !== signature.digest)
          throw new Error("Cursor reasoning signature correlation failed");
        block.signature = signature.signature;
        block.providerOptions = { cursor: { modelName: signature.modelName } };
      }
    } else if (event.type === "reasoning") {
      const block = this.reasoningBlocks.get(event.id);
      if (block) block.text = String(block.text) + event.text;
      else {
        const content = {
          type: "reasoning",
          text: event.text,
          cursorReasoningID: event.id,
        };
        this.reasoningBlocks.set(event.id, content);
        appendEntry(this.expected, { role: "assistant", content: [content] });
      }
    } else
      appendEntry(this.expected, {
        role: "assistant",
        content: [
          {
            type: "text",
            text: event.text,
          },
        ],
      });
    if (
      event.type === "text" ||
      event.type === "reasoning" ||
      event.type === "tool-call"
    )
      this.outputEntries.add(this.expected.length - 1);
    this.outputStarted = true;
    this.progress();
    this.controller?.enqueue(event);
  }

  private progress() {
    if (this.turnEnded) return;
    clearTimeout(this.stall);
    if (this.status !== "active" || this.watching.size) return;
    const timeout = this.outputStarted
      ? nativeOutputStallTimeoutMs()
      : this.resumed
        ? Number(
            process.env.OPENCODE_CURSOR_POST_TOOL_PRE_OUTPUT_STALL_TIMEOUT_MS ??
              180_000,
          )
        : Number(
            process.env.OPENCODE_CURSOR_PRE_OUTPUT_STALL_TIMEOUT_MS ?? 180_000,
          );
    if (!Number.isFinite(timeout) || timeout <= 0) return;
    this.stall = setTimeout(
      () =>
        this.dispose(
          new Error(
            `Cursor AgentService Run stalled for ${timeout}ms without model progress`,
          ),
        ),
      timeout,
    );
  }

  private scheduleDelivery() {
    if (this.status !== "active") return;
    this.delivery ??= setTimeout(
      () => this.finish("tool-calls"),
      setting("OPENCODE_CURSOR_NATIVE_TOOL_SETTLE_MS", 1_000),
    );
  }

  private releaseWatches() {
    clearTimeout(this.handoff);
    this.handoff = undefined;
    for (const release of this.watching.values()) release();
    this.watching.clear();
  }

  private finish(reason: "tool-calls" | "stop") {
    if (this.status !== "active") return;
    this.trace("Run step finished", {
      reason,
      preDeltaContextTokens: this.preDeltaContextTokens,
      latestContextTokens: this.contextTokens,
      outputTokenDelta: this.outputTokens,
      turnInput: this.usage?.input,
      turnOutput: this.usage?.output,
    });
    this.releaseWatches();
    clearTimeout(this.delivery);
    this.delivery = undefined;
    clearTimeout(this.stall);
    this.controller?.enqueue({
      type: "finish",
      reason,
      outputTokenDelta: this.outputTokens,
      turnUsage: this.usage,
      contextTokens:
        this.contextTokens === undefined
          ? undefined
          : this.checkpointSeenThisStep &&
              this.usage?.input !== undefined &&
              this.usage?.output !== undefined &&
              this.contextTokens === this.usage.input + this.usage.output
            ? this.usage.input
            : this.checkpointAfterTokenDelta
              ? Math.max(0, this.contextTokens - (this.outputTokens ?? 0))
              : this.contextTokens,
    });
    this.outputTokens = undefined;
    this.controller?.close();
    this.controller = undefined;
    this.status = "parked";
    if (reason === "tool-calls")
      this.expiry = setTimeout(
        () => this.dispose(),
        setting("OPENCODE_CURSOR_NATIVE_PARK_TTL_MS", 300_000),
      );
  }

  dispose(error?: unknown) {
    if (this.status === "closed") return;
    this.status = "closed";
    this.releaseWatches();
    this.releaseSession?.();
    clearInterval(this.heartbeat);
    clearTimeout(this.stall);
    clearTimeout(this.delivery);
    clearTimeout(this.expiry);
    this.signal?.removeEventListener("abort", this.abort);
    if (!this.turnEnded) {
      try {
        this.send({
          case: "conversationAction",
          value: create(p.ConversationActionSchema, {
            action: {
              case: "cancelAction",
              value: create(p.CancelActionSchema),
            },
          }),
        });
      } catch {
        /* Best effort; termination is bounded by the worker lifetime. */
      }
    }
    this.transport.cancel();
    this.controller?.error(
      error ?? new DOMException("Cursor Run disposed", "AbortError"),
    );
    this.controller = undefined;
    this.queued = [];
    runs.delete(this.id);
  }

  private send(message: p.AgentClientMessage["message"]) {
    this.transport.send(
      toBinary(
        p.AgentClientMessageSchema,
        create(p.AgentClientMessageSchema, { message }),
      ),
    );
  }

  // Cursor waits on every exec id, so a frame this client cannot serve is
  // failed in band with throw, then streamClose.
  private rejectExec(exec: p.ExecServerMessage, error: string) {
    this.send({
      case: "execClientControlMessage",
      value: create(p.ExecClientControlMessageSchema, {
        message: {
          case: "throw",
          value: create(p.ExecClientThrowSchema, { id: exec.id, error }),
        },
      }),
    });
    this.send({
      case: "execClientControlMessage",
      value: create(p.ExecClientControlMessageSchema, {
        message: {
          case: "streamClose",
          value: create(p.ExecClientStreamCloseSchema, { id: exec.id }),
        },
      }),
    });
  }

  // Cursor applies a native StrReplace to its materializing read as raw file
  // bytes, but host reads are formatted for the model. Its read and write are
  // declined so the model edits through the host edit tool.
  private declineNativeEdit(
    exec: p.ExecServerMessage,
    action: Extract<
      p.ExecServerMessage["message"],
      { case: "readArgs" | "writeArgs" }
    >,
  ) {
    const reason =
      "Cursor's built-in edit is unavailable here; use the host edit tool.";
    this.send({
      case: "execClientMessage",
      value: create(p.ExecClientMessageSchema, {
        id: exec.id,
        execId: exec.execId,
        message:
          action.case === "readArgs"
            ? {
                case: "readResult",
                value: create(p.ReadResultSchema, {
                  result: {
                    case: "rejected",
                    value: create(p.ReadRejectedSchema, {
                      path: action.value.path,
                      reason,
                    }),
                  },
                }),
              }
            : {
                case: "writeResult",
                value: create(p.WriteResultSchema, {
                  result: {
                    case: "rejected",
                    value: create(p.WriteRejectedSchema, {
                      path: action.value.path,
                      reason,
                    }),
                  },
                }),
              },
      }),
    });
  }

  // Cursor-hosted work bypasses host tools and permissions, so its gates are
  // declined and the model continues with host tools.
  private answer(query: p.InteractionQuery) {
    const hosted =
      "Cursor-hosted web access is disabled; use a host tool instead.";
    const response = create(p.InteractionResponseSchema, { id: query.id });
    const q = query.query;
    if (q.case === "webSearchRequestQuery")
      response.result = {
        case: "webSearchRequestResponse",
        value: create(p.WebSearchRequestResponseSchema, {
          result: {
            case: "rejected",
            value: create(p.WebSearchRequestResponse_RejectedSchema, {
              reason: hosted,
            }),
          },
        }),
      };
    else if (q.case === "exaSearchRequestQuery")
      response.result = {
        case: "exaSearchRequestResponse",
        value: create(p.ExaSearchRequestResponseSchema, {
          result: {
            case: "rejected",
            value: create(p.ExaSearchRequestResponse_RejectedSchema, {
              reason: hosted,
            }),
          },
        }),
      };
    else if (q.case === "exaFetchRequestQuery")
      response.result = {
        case: "exaFetchRequestResponse",
        value: create(p.ExaFetchRequestResponseSchema, {
          result: {
            case: "rejected",
            value: create(p.ExaFetchRequestResponse_RejectedSchema, {
              reason: hosted,
            }),
          },
        }),
      };
    else if (q.case === "askQuestionInteractionQuery")
      response.result = {
        case: "askQuestionInteractionResponse",
        value: create(p.AskQuestionInteractionResponseSchema, {
          result: create(p.AskQuestionResultSchema, {
            result: {
              case: "rejected",
              value: create(p.AskQuestionRejectedSchema, {
                reason:
                  "Cursor questions are disabled; use a host tool instead.",
              }),
            },
          }),
        }),
      };
    else if (q.case === "switchModeRequestQuery")
      response.result = {
        case: "switchModeRequestResponse",
        value: create(p.SwitchModeRequestResponseSchema, {
          result: {
            case: "rejected",
            value: create(p.SwitchModeRequestResponse_RejectedSchema, {
              reason: "Cursor mode switches are disabled.",
            }),
          },
        }),
      };
    else if (q.case === "createPlanRequestQuery")
      response.result = {
        case: "createPlanRequestResponse",
        value: create(p.CreatePlanRequestResponseSchema, {
          result: create(p.CreatePlanResultSchema, {
            result: {
              case: "error",
              value: create(p.CreatePlanErrorSchema, {
                error: "Cursor plan files are disabled.",
              }),
            },
          }),
        }),
      };
    else if (
      q.case === undefined &&
      query.$unknown?.some((field) => field.no === 9)
    )
      // Web fetch (field 9) postdates this descriptor. Its response has the
      // other gates' layout: rejected = 2 { reason = 1 }.
      response.$unknown = [
        {
          no: 9,
          wireType: WireType.LengthDelimited,
          data: new BinaryWriter()
            .bytes(
              new BinaryWriter()
                .tag(2, WireType.LengthDelimited)
                .fork()
                .tag(1, WireType.LengthDelimited)
                .string(hosted)
                .join()
                .finish(),
            )
            .finish(),
        },
      ];
    // A VM setup result can only claim success, and other queries have no
    // known reply layout.
    else throw new Error("Unsupported Cursor interaction");
    this.send({ case: "interactionResponse", value: response });
  }

  private replyResult(
    reply: { id: number; execId: string },
    result: HostToolResult,
    call?: PendingCall,
  ) {
    const outputText = extractToolOutput(result.text);
    if (call?.kind === "shellStream") {
      this.send({
        case: "execClientMessage",
        value: create(p.ExecClientMessageSchema, {
          ...reply,
          message: {
            case: "shellStream",
            value: create(p.ShellStreamSchema, {
              event: { case: "start", value: create(p.ShellStreamStartSchema) },
            }),
          },
        }),
      });
      this.send({
        case: "execClientMessage",
        value: create(p.ExecClientMessageSchema, {
          ...reply,
          message: {
            case: "shellStream",
            value: create(p.ShellStreamSchema, {
              event: result.isError
                ? {
                    case: "stderr",
                    value: create(p.ShellStreamStderrSchema, {
                      data: outputText,
                    }),
                  }
                : {
                    case: "stdout",
                    value: create(p.ShellStreamStdoutSchema, {
                      data: outputText,
                    }),
                  },
            }),
          },
        }),
      });
      const shellArgs = call.rawArgs as p.ShellArgs | undefined;
      this.send({
        case: "execClientMessage",
        value: create(p.ExecClientMessageSchema, {
          ...reply,
          message: {
            case: "shellStream",
            value: create(p.ShellStreamSchema, {
              event: {
                case: "exit",
                value: create(p.ShellStreamExitSchema, {
                  code: result.isError ? 1 : 0,
                  cwd: shellArgs?.workingDirectory || "",
                  aborted: false,
                }),
              },
            }),
          },
        }),
      });
    }

    // Cursor keeps a streamed shell exec pending until it also receives the
    // structured result and the stream is closed.
    if (call?.kind === "shell" || call?.kind === "shellStream") {
      const shellArgs = call.rawArgs as p.ShellArgs | undefined;
      this.send({
        case: "execClientMessage",
        value: create(p.ExecClientMessageSchema, {
          ...reply,
          message: {
            case: "shellResult",
            value: create(p.ShellResultSchema, {
              result: result.isError
                ? {
                    case: "failure",
                    value: create(p.ShellFailureSchema, {
                      command: shellArgs?.command || "",
                      workingDirectory: shellArgs?.workingDirectory || "",
                      exitCode: 1,
                      stderr: outputText,
                      stdout: "",
                      signal: "",
                      executionTime: 0,
                    }),
                  }
                : {
                    case: "success",
                    value: create(p.ShellSuccessSchema, {
                      command: shellArgs?.command || "",
                      workingDirectory: shellArgs?.workingDirectory || "",
                      exitCode: 0,
                      stdout: outputText,
                      stderr: "",
                      signal: "",
                      executionTime: 0,
                    }),
                  },
            }),
          },
        }),
      });
      if (call.kind === "shellStream")
        this.send({
          case: "execClientControlMessage",
          value: create(p.ExecClientControlMessageSchema, {
            message: {
              case: "streamClose",
              value: create(p.ExecClientStreamCloseSchema, { id: reply.id }),
            },
          }),
        });
      return;
    }

    if (call?.kind === "read") {
      const readArgs = call.rawArgs as p.ReadArgs | undefined;
      const path = readArgs?.path || "";
      this.send({
        case: "execClientMessage",
        value: create(p.ExecClientMessageSchema, {
          ...reply,
          message: {
            case: "readResult",
            value: create(p.ReadResultSchema, {
              result: result.isError
                ? {
                    case: "error",
                    value: create(p.ReadErrorSchema, {
                      path,
                      error: outputText,
                    }),
                  }
                : {
                    case: "success",
                    value: create(p.ReadSuccessSchema, {
                      path,
                      totalLines: outputText.split("\n").length,
                      fileSize: BigInt(Buffer.byteLength(outputText)),
                      truncated: false,
                      output: {
                        case: "content",
                        value: outputText,
                      },
                    }),
                  },
            }),
          },
        }),
      });
      return;
    }

    if (call?.kind === "grep") {
      const grepArgs = call.rawArgs as p.GrepArgs | undefined;
      const pattern = grepArgs?.pattern ?? "";
      const path = grepArgs?.path ?? "";
      const outputMode = grepArgs?.outputMode ?? "content";

      if (result.isError) {
        this.send({
          case: "execClientMessage",
          value: create(p.ExecClientMessageSchema, {
            ...reply,
            message: {
              case: "grepResult",
              value: create(p.GrepResultSchema, {
                result: {
                  case: "error",
                  value: create(p.GrepErrorSchema, {
                    error: result.text,
                  }),
                },
              }),
            },
          }),
        });
        return;
      }

      const isFileSearch =
        outputMode === "files_with_matches" ||
        !pattern ||
        pattern.trim() === "";

      if (isFileSearch) {
        const files = outputText
          .split("\n")
          .map((s) => s.trim())
          .filter(
            (s) =>
              s.length > 0 &&
              !s.startsWith("(") &&
              !s.startsWith("No files found") &&
              !s.startsWith("No matches found"),
          );
        this.send({
          case: "execClientMessage",
          value: create(p.ExecClientMessageSchema, {
            ...reply,
            message: {
              case: "grepResult",
              value: create(p.GrepResultSchema, {
                result: {
                  case: "success",
                  value: create(p.GrepSuccessSchema, {
                    pattern,
                    path,
                    outputMode: "files_with_matches",
                    workspaceResults: {
                      "": create(p.GrepUnionResultSchema, {
                        result: {
                          case: "files",
                          value: create(p.GrepFilesResultSchema, { files }),
                        },
                      }),
                    },
                  }),
                },
              }),
            },
          }),
        });
        return;
      }

      const fileMatches: p.GrepFileMatch[] = [];
      let currentFile: p.GrepFileMatch | undefined;
      for (const line of outputText.split("\n")) {
        const lineMatch = /^\s*Line\s+(\d+):\s*(.*)$/.exec(line);
        if (lineMatch && currentFile) {
          currentFile.matches.push(
            create(p.GrepContentMatchSchema, {
              lineNumber: Number(lineMatch[1]),
              content: lineMatch[2] ?? "",
            }),
          );
          continue;
        }
        const colonMatch = /^([^:\n]+):(\d+):(.*)$/.exec(line);
        if (colonMatch) {
          const file = colonMatch[1]!;
          if (!currentFile || currentFile.file !== file) {
            currentFile = create(p.GrepFileMatchSchema, { file, matches: [] });
            fileMatches.push(currentFile);
          }
          currentFile.matches.push(
            create(p.GrepContentMatchSchema, {
              lineNumber: Number(colonMatch[2]),
              content: colonMatch[3] ?? "",
            }),
          );
          continue;
        }
        const fileHeader = /^([^:\n]+):$/.exec(line);
        if (fileHeader) {
          currentFile = create(p.GrepFileMatchSchema, {
            file: fileHeader[1]!,
            matches: [],
          });
          fileMatches.push(currentFile);
          continue;
        }
      }
      if (
        !fileMatches.length &&
        outputText &&
        !outputText.includes("No matches found")
      ) {
        fileMatches.push(
          create(p.GrepFileMatchSchema, {
            file: path || "workspace",
            matches: [
              create(p.GrepContentMatchSchema, {
                lineNumber: 1,
                content: outputText,
              }),
            ],
          }),
        );
      }
      const total = fileMatches.reduce((acc, f) => acc + f.matches.length, 0);
      this.send({
        case: "execClientMessage",
        value: create(p.ExecClientMessageSchema, {
          ...reply,
          message: {
            case: "grepResult",
            value: create(p.GrepResultSchema, {
              result: {
                case: "success",
                value: create(p.GrepSuccessSchema, {
                  pattern,
                  path,
                  outputMode: "content",
                  workspaceResults: {
                    "": create(p.GrepUnionResultSchema, {
                      result: {
                        case: "content",
                        value: create(p.GrepContentResultSchema, {
                          matches: fileMatches,
                          totalLines: total,
                          totalMatchedLines: total,
                          ripgrepTruncated: false,
                        }),
                      },
                    }),
                  },
                }),
              },
            }),
          },
        }),
      });
      return;
    }

    if (call?.kind === "write") {
      const writeArgs = call.rawArgs as p.WriteArgs | undefined;
      const fileText = writeArgs?.fileText ?? "";
      this.send({
        case: "execClientMessage",
        value: create(p.ExecClientMessageSchema, {
          ...reply,
          message: {
            case: "writeResult",
            value: create(p.WriteResultSchema, {
              result: result.isError
                ? {
                    case: "error",
                    value: create(p.WriteErrorSchema, {
                      error: outputText,
                    }),
                  }
                : {
                    case: "success",
                    value: create(p.WriteSuccessSchema, {
                      path: writeArgs?.path || "",
                      linesCreated: fileText.split("\n").length,
                      fileSize: Buffer.byteLength(fileText),
                    }),
                  },
            }),
          },
        }),
      });
      return;
    }

    if (call?.kind === "ls") {
      const lsArgs = call.rawArgs as p.LsArgs | undefined;
      if (result.isError) {
        this.send({
          case: "execClientMessage",
          value: create(p.ExecClientMessageSchema, {
            ...reply,
            message: {
              case: "lsResult",
              value: create(p.LsResultSchema, {
                result: {
                  case: "error",
                  value: create(p.LsErrorSchema, {
                    error: outputText,
                  }),
                },
              }),
            },
          }),
        });
        return;
      }
      const entries = outputText
        .split("\n")
        .map((s) => s.trim())
        .filter(
          (s) =>
            s.length > 0 &&
            !s.startsWith("(") &&
            !s.startsWith("No files found"),
        );
      this.send({
        case: "execClientMessage",
        value: create(p.ExecClientMessageSchema, {
          ...reply,
          message: {
            case: "lsResult",
            value: create(p.LsResultSchema, {
              result: {
                case: "success",
                value: create(p.LsSuccessSchema, {
                  directoryTreeRoot: create(p.LsDirectoryTreeNodeSchema, {
                    absPath: lsArgs?.path || ".",
                    childrenFiles: entries.map((name) =>
                      create(p.LsDirectoryTreeNode_FileSchema, {
                        name,
                      }),
                    ),
                    childrenDirs: [],
                  }),
                }),
              },
            }),
          },
        }),
      });
      return;
    }

    this.send({
      case: "execClientMessage",
      value: create(p.ExecClientMessageSchema, {
        ...reply,
        message: {
          case: "mcpResult",
          value: create(p.McpResultSchema, {
            result: {
              case: "success",
              value: create(p.McpSuccessSchema, {
                isError: result.isError,
                content: [
                  create(p.McpToolResultContentItemSchema, {
                    content: {
                      case: "text",
                      value: create(p.McpTextContentSchema, {
                        text: result.text,
                      }),
                    },
                  }),
                ],
              }),
            },
          }),
        },
      }),
    });
  }

  private receive(message: p.AgentServerMessage) {
    if (this.status === "closed") return;
    const item = message.message;
    if (item.case === "interactionUpdate") {
      const update = item.value.message;
      if (
        this.tracing &&
        (update.case === "toolCallStarted" ||
          update.case === "partialToolCall" ||
          update.case === "toolCallCompleted")
      ) {
        const tool = update.value.toolCall?.tool;
        const result = record(record(tool?.value)?.result)?.result;
        this.trace("Cursor tool update", {
          phase: update.case,
          kind: tool?.case ?? "unknown",
          result: record(result)?.case ?? "none",
        });
      }
      // SDK 1.0.31: field 21 is a feedback-form notification; 25 is an
      // optional timestamp. Neither is model output or an execution request.
      // The base AgentService descriptor retains these as unknown fields.
      if (
        update.case === undefined &&
        item.value.$unknown?.some((field) => field.no === 21) &&
        item.value.$unknown.every((field) => field.no === 21 || field.no === 25)
      )
        return;
      if (this.turnEnded && update.case !== "heartbeat")
        throw new Error("Cursor sent output after turnEnded");
      if (update.case === "textDelta" || update.case === "thinkingDelta") {
        if (update.value.text)
          this.emit(
            update.case === "textDelta"
              ? { type: "text", text: update.value.text }
              : {
                  type: "reasoning",
                  text: update.value.text,
                  id: (this.reasoningID ??= randomUUID()),
                },
          );
      } else if (update.case === "thinkingCompleted") {
        this.reasoningID = undefined;
      } else if (
        update.case === "toolCallStarted" ||
        update.case === "partialToolCall"
      ) {
        if (update.value.toolCall?.tool.case === "editToolCall") {
          if (
            this.nativeEdits.size >= 1024 &&
            !this.nativeEdits.has(update.value.callId)
          )
            throw new Error("Cursor native edit capacity exceeded");
          this.nativeEdits.add(update.value.callId);
        }
      } else if (update.case === "tokenDelta") {
        if (update.value.tokens < 0)
          throw new Error("Cursor reported a negative output token delta");
        this.outputTokens = (this.outputTokens ?? 0) + update.value.tokens;
        if (update.value.tokens > 0) {
          this.sawTokenDelta = true;
          this.outputStarted = true;
          this.progress();
        }
      } else if (update.case === "turnEnded") {
        if (this.pendingCount)
          throw new Error("Cursor ended its turn with unresolved host tools");
        this.turnEnded = true;
        this.usage = readTurnUsage(update.value);
        clearInterval(this.heartbeat);
        clearTimeout(this.stall);
        this.stall = setTimeout(
          () =>
            this.dispose(
              new Error("Cursor transport did not finish after turnEnded"),
            ),
          5_000,
        );
        // Keep the request writable for final blob operations/checkpoints. The
        // server's validated Connect end status, not turnEnded, closes the Run.
      }
      return;
    }
    if (item.case === "conversationCheckpointUpdate") {
      // A checkpoint without token details must not erase known occupancy.
      if (item.value.tokenDetails?.usedTokens) {
        this.contextTokens = item.value.tokenDetails.usedTokens;
        this.checkpointSeenThisStep = true;
        this.checkpointAfterTokenDelta = this.sawTokenDelta;
        if (!this.sawTokenDelta)
          this.preDeltaContextTokens = this.contextTokens;
        this.trace("Cursor checkpoint", {
          usedTokens: this.contextTokens,
          beforeTokenDelta: !this.sawTokenDelta,
        });
      }
      this.checkpointRoots.clear();
      for (const id of item.value.rootPromptMessagesJson) {
        const key = Buffer.from(id).toString("hex");
        if (this.checkpointRoots.size >= 8192 && !this.checkpointRoots.has(key))
          throw new Error("Cursor checkpoint root capacity exceeded");
        this.checkpointRoots.add(key);
        const signed = this.signedRoots.get(key);
        if (!signed) continue;
        const signatures: ReasoningSignature[] = [];
        for (const part of signed) {
          const blocks = [...this.reasoningBlocks].filter(
            ([, block]) =>
              block.text === part.text && block.signature === undefined,
          );
          if (blocks.length !== 1) continue;
          signatures.push({
            id: blocks[0]![0],
            digest: reasoningDigest(part.text),
            signature: part.signature,
            modelName: part.modelName,
          });
        }
        this.signedRoots.delete(key);
        if (signatures.length)
          this.emit({ type: "reasoning-metadata", signatures });
      }
      return;
    }
    if (item.case === "kvServerMessage") {
      const action = item.value.message;
      let result: p.KvClientMessage["message"];
      if (action.case === "getBlobArgs")
        result = {
          case: "getBlobResult",
          value: create(p.GetBlobResultSchema, {
            blobData: this.payload.blobs.get(action.value.blobId),
          }),
        };
      else if (action.case === "setBlobArgs") {
        this.payload.blobs.set(action.value.blobId, action.value.blobData);
        // Only assistant roots later referenced by a checkpoint can enrich
        // reasoning. Arbitrary tool/file blobs are never promoted to history.
        let json: unknown;
        try {
          json = JSON.parse(Buffer.from(action.value.blobData).toString());
        } catch {
          /* Other blobs are protobuf or binary. */
        }
        const root = record(json);
        const key = Buffer.from(action.value.blobId).toString("hex");
        this.redactedRoots.delete(key);
        if (root?.role === "assistant" && Array.isArray(root.content)) {
          if (
            root.content.some(
              (part: unknown) => record(part)?.type === "redacted-reasoning",
            )
          ) {
            this.redactedRoots.set(key, root.content as JsonValue[]);
          }
          const signed = root.content.flatMap((item: unknown) => {
            const part = record(item);
            const modelName = record(
              record(part?.providerOptions)?.cursor,
            )?.modelName;
            return part?.type === "reasoning" &&
              typeof part.text === "string" &&
              typeof part.signature === "string" &&
              part.signature.length > 0 &&
              part.signature.length <= 65536 &&
              modelName === this.input.selection.publicId
              ? [{ text: part.text, signature: part.signature, modelName }]
              : [];
          });
          if (signed.length)
            this.signedRoots.set(
              Buffer.from(action.value.blobId).toString("hex"),
              signed,
            );
        }
        result = {
          case: "setBlobResult",
          value: create(p.SetBlobResultSchema),
        };
      } else throw new Error("Unsupported Cursor blob operation");
      this.send({
        case: "kvClientMessage",
        value: create(p.KvClientMessageSchema, {
          id: item.value.id,
          message: result,
        }),
      });
      return;
    }
    if (this.turnEnded) throw new Error("Cursor sent work after turnEnded");
    if (item.case === "execServerMessage") {
      const exec = item.value;
      const action = exec.message;
      this.trace("Cursor exec request", {
        kind: action.case ?? "unknown",
      });
      if (action.case === "requestContextArgs") {
        this.send({
          case: "execClientMessage",
          value: create(p.ExecClientMessageSchema, {
            id: exec.id,
            execId: exec.execId,
            message: {
              case: "requestContextResult",
              value: create(p.RequestContextResultSchema, {
                result: {
                  case: "success",
                  value: create(p.RequestContextSuccessSchema, {
                    requestContext: this.payload.context,
                  }),
                },
              }),
            },
          }),
        });
        return;
      }
      if (!action.case)
        return this.rejectExec(exec, "Unknown exec message variant");
      if (
        (action.case === "readArgs" || action.case === "writeArgs") &&
        this.nativeEdits.has(action.value.toolCallId)
      )
        return this.declineNativeEdit(exec, action);

      let name: string | undefined;
      let input: string;
      let toolCallId: string;
      let kind: PendingCall["kind"] = "mcp";
      let rawArgs: unknown = action.value;

      if (action.case === "mcpArgs") {
        const args = action.value;
        name = args.toolName || args.name;
        if (!this.input.tools.some((tool) => tool.function.name === name))
          throw new Error("Cursor requested an unadvertised MCP tool");
        if (!args.toolCallId) throw new Error("Cursor omitted the tool call ID");
        toolCallId = args.toolCallId;
        input = decodeArgs(args.args);
        kind = "mcp";

        if (name === "grep") {
          try {
            const parsed = JSON.parse(input);
            if (
              (!parsed.pattern || String(parsed.pattern).trim() === "") &&
              (parsed.include || parsed.glob) &&
              this.input.tools.some((tool) => tool.function.name === "glob")
            ) {
              name = "glob";
              const repairedInput: Record<string, unknown> = {
                pattern: parsed.include || parsed.glob,
              };
              if (parsed.path) repairedInput.path = parsed.path;
              if (parsed.limit) repairedInput.limit = parsed.limit;
              input = JSON.stringify(repairedInput);
            }
          } catch {
            // retain original input
          }
        } else if (name === "glob") {
          try {
            const parsed = JSON.parse(input);
            if (!parsed.pattern && (parsed.glob || parsed.include)) {
              parsed.pattern = parsed.glob || parsed.include;
              delete parsed.glob;
              delete parsed.include;
              input = JSON.stringify(parsed);
            }
          } catch {
            // retain original input
          }
        } else if (name === "read") {
          try {
            const parsed = JSON.parse(input);
            if (!parsed.path && parsed.filePath) {
              parsed.path = parsed.filePath;
              delete parsed.filePath;
              input = JSON.stringify(parsed);
            }
          } catch {
            // retain original input
          }
        }
      } else if (
        action.case === "shellStreamArgs" ||
        action.case === "shellArgs"
      ) {
        const args = action.value;
        const shellTool = this.input.tools.find(
          (t) => t.function.name === "shell" || t.function.name === "bash",
        );
        name = shellTool?.function.name ?? "shell";
        toolCallId = args.toolCallId || `shell_${exec.id}`;
        const toolInput: Record<string, unknown> = {
          command: args.command,
        };
        if (args.workingDirectory) toolInput.workdir = args.workingDirectory;
        if (args.timeout && args.timeout > 0)
          toolInput.timeout = args.timeout * 1000;
        input = JSON.stringify(toolInput);
        kind = action.case === "shellStreamArgs" ? "shellStream" : "shell";
      } else if (action.case === "grepArgs") {
        const args = action.value;
        const isFileSearch = !args.pattern || args.pattern.trim() === "";
        const globPattern = args.glob || "*";
        if (isFileSearch) {
          const globTool = this.input.tools.find(
            (t) => t.function.name === "glob",
          );
          name = globTool?.function.name ?? "glob";
          toolCallId = args.toolCallId || `glob_${exec.id}`;
          const toolInput: Record<string, unknown> = {
            pattern: globPattern,
          };
          if (args.path) toolInput.path = args.path;
          if (args.headLimit && args.headLimit > 0)
            toolInput.limit = args.headLimit;
          input = JSON.stringify(toolInput);
          kind = "grep";
        } else {
          const grepTool = this.input.tools.find(
            (t) => t.function.name === "grep",
          );
          name = grepTool?.function.name ?? "grep";
          toolCallId = args.toolCallId || `grep_${exec.id}`;
          const toolInput: Record<string, unknown> = {
            pattern: args.pattern,
          };
          if (args.path) toolInput.path = args.path;
          if (args.glob) toolInput.include = args.glob;
          if (args.caseInsensitive !== undefined)
            toolInput.caseSensitive = !args.caseInsensitive;
          if (args.headLimit && args.headLimit > 0)
            toolInput.limit = args.headLimit;
          input = JSON.stringify(toolInput);
          kind = "grep";
        }
      } else if (action.case === "readArgs") {
        const args = action.value;
        const readTool = this.input.tools.find((t) => t.function.name === "read");
        name = readTool?.function.name ?? "read";
        toolCallId = args.toolCallId || `read_${exec.id}`;
        input = JSON.stringify({ path: args.path });
        kind = "read";
      } else if (action.case === "writeArgs") {
        const args = action.value;
        const writeTool = this.input.tools.find((t) => t.function.name === "write");
        name = writeTool?.function.name ?? "write";
        toolCallId = args.toolCallId || `write_${exec.id}`;
        input = JSON.stringify({ path: args.path, content: args.fileText });
        kind = "write";
      } else if (action.case === "lsArgs") {
        const args = action.value;
        const lsTool = this.input.tools.find(
          (t) => t.function.name === "glob" || t.function.name === "read",
        );
        name = lsTool?.function.name ?? "glob";
        toolCallId = args.toolCallId || `ls_${exec.id}`;
        input = JSON.stringify({ pattern: "*", path: args.path || undefined });
        kind = "ls";
      } else {
        return this.rejectExec(
          exec,
          `Cursor ${action.case} is not implemented by this client`,
        );
      }

      if (!this.input.tools.some((tool) => tool.function.name === name)) {
        if (action.case === "mcpArgs")
          throw new Error("Cursor requested an unadvertised MCP tool");
        const errorResult: HostToolResult = {
          id: toolCallId,
          name: name ?? "unknown",
          text: `Tool '${name}' is not available in this workspace`,
          isError: true,
        };
        const syntheticCall: PendingCall = {
          upstreamID: toolCallId,
          id: toolCallId,
          name: name ?? "unknown",
          input,
          replies: [{ id: exec.id, execId: exec.execId }],
          status: "forwarded",
          result: errorResult,
          kind,
          rawArgs,
        };
        this.replyResult(
          { id: exec.id, execId: exec.execId },
          errorResult,
          syntheticCall,
        );
        return;
      }

      const reply = { id: exec.id, execId: exec.execId };
      const existing = this.calls.get(toolCallId);
      if (existing) {
        if (existing.name !== name || existing.input !== input)
          throw new Error("Conflicting Cursor tool call retransmission");
        if (
          existing.replies.some(
            (item) => item.id === reply.id && item.execId === reply.execId,
          )
        ) {
          if (existing.result) this.replyResult(reply, existing.result, existing);
          return;
        }
        if (existing.replies.length >= 16)
          throw new Error("Cursor tool retransmission capacity exceeded");
        existing.replies.push(reply);
        if (existing.result) this.replyResult(reply, existing.result, existing);
        return;
      }
      if (this.calls.size >= 1024)
        throw new Error("Cursor Run tool capacity exceeded");
      const call: PendingCall = {
        upstreamID: toolCallId,
        id: `cursor_${hash(`${this.nonce}:${toolCallId}`).slice(0, 32)}`,
        name,
        input,
        replies: [reply],
        status: "queued",
        kind,
        rawArgs,
      };
      this.calls.set(toolCallId, call);
      this.emit({
        type: "tool-call",
        toolCallId: call.id,
        toolName: name,
        input,
      });
      return;
    }
    if (item.case === "interactionQuery") return this.answer(item.value);
    if (item.case === undefined)
      throw new Error("Unsupported Cursor interaction");
  }

  private preserveOpaqueReasoning() {
    const annotations: OpaqueReasoning[] = [];
    for (const key of this.checkpointRoots) {
      try {
        const root = this.redactedRoots.get(key);
        if (!root) continue;
        const incompatible = root.some((value) => {
          const modelName = record(
            record(record(value)?.providerOptions)?.cursor,
          )?.modelName;
          return (
            modelName !== undefined &&
            modelName !== this.input.selection.publicId
          );
        });
        if (incompatible) continue;
        const content = root.map((value): JsonValue => {
          const part = record(value);
          if (part?.type !== "tool-call" || typeof part.toolCallId !== "string")
            return value;
          const call = this.calls.get(part.toolCallId);
          return call
            ? { ...(value as JsonObject), toolCallId: call.id }
            : value;
        });
        const annotation = captureOpaqueReasoning(
          content,
          this.input.selection.publicId,
        );
        const alreadyStored = this.input.history.some(
          (entry) =>
            entry.role === "assistant" &&
            entry.content.some(
              (part) => record(part)?.type === "redacted-reasoning",
            ) &&
            stableJson(
              captureOpaqueReasoning(
                entry.content,
                this.input.selection.publicId,
              ),
            ) === stableJson(annotation),
        );
        if (alreadyStored) continue;
        const matches = [...this.outputEntries].filter((index) => {
          const entry = this.expected[index];
          return (
            entry?.role === "assistant" &&
            opaqueAnchorDigest(entry.content) === annotation.digest
          );
        });
        // Unmatched extra checkpoint roots are common for Grok. Omit them
        // instead of failing an already-streamed answer.
        if (matches.length !== 1) continue;
        annotations.push(annotation);
      } catch {
        continue;
      }
    }
    if (!annotations.length) return;
    try {
      this.emit({
        type: "opaque-reasoning",
        annotations: opaqueReasoning(annotations),
      });
    } catch {
      return;
    }
  }
}
