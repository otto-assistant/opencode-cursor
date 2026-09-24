import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  SharedV3Warning,
  SharedV3ProviderMetadata,
} from "@ai-sdk/provider";
import { Plugin, Provider } from "@opencode/plugin";
import type { CursorToolDefinition } from "../tools.js";
import { currentCursorModels } from "../models/catalog.js";
import {
  CURSOR_SELECTION_HEADER,
  selectionForCursorRequest,
  type CursorModelSelection,
} from "../model-selection.js";
import {
  runCursorAgent,
  stopCursorTransport,
  type CursorRunEvent,
} from "../cursor-agent.js";
import { compileHistory, record } from "./history.js";
import { HostToolObserver } from "./tool-observer.js";
import type { CursorTokenUsage } from "../cursor-agent-usage.js";
import {
  CURSOR_INTEGRATION_ID,
  type DisposableRegistration,
} from "./integration.js";

type AccessTokenProvider = () => Promise<string>;
const SESSION_HEADER = "x-opencode-cursor-host-session";

export interface CursorLanguageModelOptions {
  modelId: string;
  selection: CursorModelSelection;
  getAccessToken: AccessTokenProvider;
  apiUrl?: string;
  scope?: string;
  toolObserver?: HostToolObserver;
}

// Cursor reports conversation occupancy, not per-call input or a cache split.
// OpenCode stores only uncached input, so occupancy is reported as uncached to
// keep its context meter and compaction accurate. Exact Run counters stay in
// providerMetadata.cursor.turnUsage.
function usage(
  contextTokens?: number,
  outputTokens?: number,
): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: contextTokens,
      noCache: contextTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTokens,
      text: undefined,
      reasoning: undefined,
    },
  };
}

function reportedCounts(counts: CursorTokenUsage): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts))
    if (value !== undefined) result[key] = value;
  return result;
}

function compileTools(
  tools: LanguageModelV3CallOptions["tools"],
  choice: LanguageModelV3CallOptions["toolChoice"],
): CursorToolDefinition[] {
  if (choice?.type === "none") return [];
  if (tools?.some((tool) => tool.type !== "function"))
    throw new Error("Cursor supports host-executed function tools only");
  return (tools ?? [])
    .filter((tool) => tool.type === "function")
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown>,
      },
    }));
}

export function createCursorLanguageModel(
  options: CursorLanguageModelOptions,
): LanguageModelV3 {
  const scope = options.scope ?? crypto.randomUUID();
  const doStream: LanguageModelV3["doStream"] = async (call) => {
    call.abortSignal?.throwIfAborted();
    const prompt = compileHistory(call.prompt);
    const tools = compileTools(call.tools, call.toolChoice);
    const warnings: SharedV3Warning[] = [];
    if (
      call.toolChoice?.type === "required" ||
      call.toolChoice?.type === "tool"
    )
      warnings.push({
        type: "unsupported",
        feature: "toolChoice",
        details: "Cursor AgentService chooses tools internally.",
      });
    const sessionID = call.headers?.[SESSION_HEADER];
    const cursorStream = runCursorAgent({
      accessToken: await options.getAccessToken(),
      selection: options.selection,
      history: prompt.entries,
      results: prompt.results,
      tools,
      scope: `${scope}:${call.headers?.[SESSION_HEADER] ?? "direct"}`,
      abortSignal: call.abortSignal,
      apiUrl: options.apiUrl,
      host:
        sessionID && options.toolObserver
          ? { sessionID, observer: options.toolObserver }
          : undefined,
    });
    let openBlock: { type: "text" | "reasoning"; id: string } | undefined;
    const closeBlock = (
      controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
    ) => {
      if (!openBlock) return;
      controller.enqueue({
        type: openBlock.type === "text" ? "text-end" : "reasoning-end",
        id: openBlock.id,
      });
      openBlock = undefined;
    };
    return {
      stream: cursorStream.pipeThrough(
        new TransformStream<CursorRunEvent, LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings });
          },
          transform(event, controller) {
            if (event.type === "text" || event.type === "reasoning") {
              if (
                openBlock?.type !== event.type ||
                (event.type === "reasoning" && openBlock.id !== event.id)
              ) {
                closeBlock(controller);
                openBlock = {
                  type: event.type,
                  id:
                    event.type === "reasoning" ? event.id : crypto.randomUUID(),
                };
                controller.enqueue({
                  type:
                    event.type === "text" ? "text-start" : "reasoning-start",
                  id: openBlock.id,
                  ...(event.type === "reasoning"
                    ? {
                        providerMetadata: { cursor: { reasoningID: event.id } },
                      }
                    : {}),
                });
              }
              controller.enqueue({
                type: event.type === "text" ? "text-delta" : "reasoning-delta",
                id: openBlock.id,
                delta: event.text,
              });
              return;
            }
            closeBlock(controller);
            if (
              event.type === "reasoning-metadata" ||
              event.type === "opaque-reasoning"
            ) {
              const id = crypto.randomUUID();
              controller.enqueue({ type: "reasoning-start", id });
              controller.enqueue({
                type: "reasoning-end",
                id,
                providerMetadata: {
                  cursor:
                    event.type === "opaque-reasoning"
                      ? {
                          opaqueReasoning: event.annotations.map(
                            (annotation) => ({
                              digest: annotation.digest,
                              modelName: annotation.modelName,
                              blocks: annotation.blocks.map((block) => ({
                                ...block,
                              })),
                            }),
                          ),
                        }
                      : {
                          reasoningSignatures: event.signatures.map(
                            (signature) => ({
                              ...signature,
                            }),
                          ),
                        },
                },
              });
              return;
            }
            if (event.type === "tool-call") {
              controller.enqueue({
                type: "tool-call",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                input: event.input,
              });
              return;
            }
            controller.enqueue({
              type: "finish",
              usage: usage(event.contextTokens, event.outputTokenDelta),
              finishReason: { unified: event.reason, raw: event.reason },
              providerMetadata: {
                cursor: {
                  ...(event.contextTokens === undefined
                    ? {}
                    : { contextTokens: event.contextTokens }),
                  ...(event.outputTokenDelta === undefined
                    ? {}
                    : { outputTokenDelta: event.outputTokenDelta }),
                  usageScope: "cursor-turn",
                  ...(event.turnUsage === undefined
                    ? {}
                    : { turnUsage: reportedCounts(event.turnUsage) }),
                  billedCost: "unavailable",
                },
              },
            });
          },
        }),
      ),
    };
  };
  return {
    specificationVersion: "v3",
    provider: CURSOR_INTEGRATION_ID,
    modelId: options.modelId,
    supportedUrls: {},
    doStream,
    async doGenerate(call) {
      const result = await doStream(call);
      const content: LanguageModelV3Content[] = [];
      let finalUsage = usage();
      let finishReason: LanguageModelV3FinishReason = {
        unified: "other",
        raw: undefined,
      };
      let warnings: SharedV3Warning[] = [];
      let providerMetadata: SharedV3ProviderMetadata | undefined;
      const blocks = new Map<
        string,
        Extract<LanguageModelV3Content, { type: "text" | "reasoning" }>
      >();
      for await (const part of result.stream) {
        if (part.type === "stream-start") warnings = part.warnings;
        if (part.type === "text-start" || part.type === "reasoning-start") {
          const block = {
            type:
              part.type === "text-start"
                ? ("text" as const)
                : ("reasoning" as const),
            text: "",
            providerMetadata: part.providerMetadata,
          };
          blocks.set(part.id, block);
          content.push(block);
        }
        if (part.type === "text-delta" || part.type === "reasoning-delta") {
          const block = blocks.get(part.id);
          if (block) block.text += part.delta;
        }
        if (part.type === "text-end" || part.type === "reasoning-end") {
          const block = blocks.get(part.id);
          if (block && part.providerMetadata)
            block.providerMetadata = {
              ...block.providerMetadata,
              ...part.providerMetadata,
            };
        }
        if (part.type === "tool-call") content.push(part);
        if (part.type === "error") throw part.error;
        if (part.type === "finish") {
          finalUsage = part.usage;
          finishReason = part.finishReason;
          providerMetadata = part.providerMetadata;
        }
      }
      return {
        content,
        usage: finalUsage,
        finishReason,
        warnings,
        providerMetadata,
      };
    },
  };
}

type LanguageContext = Pick<Plugin.Context, "aisdk" | "session" | "event">;

async function disposeRegistrations(
  registrations: readonly DisposableRegistration[],
): Promise<void> {
  let firstError: unknown;
  for (const registration of registrations) {
    try {
      await registration.dispose();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

export async function registerCursorLanguage(
  context: LanguageContext,
  getAccessToken: AccessTokenProvider,
  scope = crypto.randomUUID(),
): Promise<DisposableRegistration> {
  const providerID = Provider.ID.make(CURSOR_INTEGRATION_ID);
  const registrations: DisposableRegistration[] = [];
  const observer = new HostToolObserver(context.event);
  registrations.push(observer);
  try {
    for (const kind of ["context", "compaction", "generate", "title"] as const) {
      registrations.push(
        await context.session.hook(
          kind,
          (event) => {
            event.messages = event.messages.map((message) => ({
              ...message,
              content: message.content.map((part) => {
                if (part.type !== "tool-result" || part.result.type !== "error")
                  return part;
                return {
                  ...part,
                  providerMetadata: {
                    ...part.providerMetadata,
                    cursor: {
                      ...record(part.providerMetadata?.cursor),
                      toolResultError: true,
                    },
                  },
                };
              }),
            }));
          },
          { providerID },
        ),
      );
    }
    registrations.push(
      await context.session.hook(
        "model.request",
        (event) => {
          event.headers[SESSION_HEADER] = event.sessionID;
        },
        { providerID },
      ),
    );
    registrations.push(
      await context.aisdk.hook(
        "sdk",
        (event) => {
          event.sdk = {
            languageModel() {
              throw new Error("Cursor language hook was not installed");
            },
          };
        },
        { providerID },
      ),
    );
    registrations.push(
      await context.aisdk.hook(
        "language",
        (event) => {
          const selection = selectionForCursorRequest(
            currentCursorModels(),
            event.model.id,
            event.model.headers?.[CURSOR_SELECTION_HEADER],
          );
          event.language = createCursorLanguageModel({
            modelId: event.model.id,
            selection,
            getAccessToken,
            scope,
            toolObserver: observer,
          });
        },
        { providerID },
      ),
    );
  } catch (error) {
    await disposeRegistrations(registrations.reverse()).catch(() => undefined);
    throw error;
  }
  let disposed = false;
  return {
    async dispose() {
      if (disposed) return;
      disposed = true;
      stopCursorTransport(scope);
      await disposeRegistrations(registrations.reverse());
    },
  };
}
