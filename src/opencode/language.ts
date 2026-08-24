import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  SharedV3Warning,
} from "@ai-sdk/provider";
import { Plugin, Provider } from "@opencode-ai/plugin";
import type { ExtractedImage, OpenAIToolDef } from "../openai/types.js";
import { truncateToolResultForCursor } from "../openai/tool-results.js";
import {
  CURSOR_SELECTION_HEADER,
  decodeCursorModelSelection,
  literalCursorModelSelection,
  type CursorModelSelection,
} from "../model-selection.js";
import {
  discardCursorAgent,
  resumeCursorAgent,
  runCursorAgent,
  type CursorRunEvent,
  type CursorToolResult,
} from "../cursor-agent.js";
import { CURSOR_INTEGRATION_ID, type DisposableRegistration } from "./integration.js";

type AccessTokenProvider = () => Promise<string>;

function extractWorkspaceRoot(systemPrompt: string): string | undefined {
  return systemPrompt.match(/Working directory:\s*(\S+)/i)?.[1] ??
    systemPrompt.match(/Workspace root folder:\s*(\S+)/i)?.[1];
}

export interface CursorLanguageModelOptions {
  modelId: string;
  selection: CursorModelSelection;
  getAccessToken: AccessTokenProvider;
  apiUrl?: string;
}

const emptyUsage = (): LanguageModelV3Usage => ({
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: undefined,
    text: undefined,
    reasoning: undefined,
  },
});

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toolResultText(output: Extract<
  LanguageModelV3CallOptions["prompt"][number],
  { role: "tool" }
>["content"][number]): string {
  if (output.type !== "tool-result") return "";
  let text: string;
  switch (output.output.type) {
    case "text":
    case "error-text":
      text = output.output.value;
      break;
    case "json":
    case "error-json":
      text = stringify(output.output.value);
      break;
    case "execution-denied":
      text = output.output.reason ?? "Tool execution denied";
      break;
    case "content":
      text = output.output.value
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      break;
  }
  return truncateToolResultForCursor(text);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function toolResultIsError(output: Extract<
  LanguageModelV3CallOptions["prompt"][number],
  { role: "tool" }
>["content"][number]): boolean {
  if (output.type !== "tool-result") return false;
  if (
    output.output.type === "error-text" ||
    output.output.type === "error-json" ||
    output.output.type === "execution-denied"
  ) {
    return true;
  }
  return record(output.providerOptions?.cursor)?.toolResultError === true;
}

function compilePrompt(prompt: LanguageModelV3CallOptions["prompt"]): {
  systemPrompt: string;
  userText: string;
  images: ExtractedImage[];
  toolResults: CursorToolResult[];
  continuationToolResults: CursorToolResult[];
} {
  const system: string[] = [];
  const transcript: string[] = [];
  const images: ExtractedImage[] = [];
  const toolResults: CursorToolResult[] = [];
  const continuationToolResults: CursorToolResult[] = [];
  let continuationStart = prompt.length;
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    if (prompt[index]?.role !== "tool") break;
    continuationStart = index;
  }

  for (const [messageIndex, message] of prompt.entries()) {
    if (message.role === "system") {
      system.push(message.content);
      continue;
    }
    if (message.role === "user") {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      transcript.push(`[OpenCode user]\n${text || "(image attachment)"}`);
      for (const part of message.content) {
        if (part.type !== "file" || !part.mediaType.startsWith("image/")) continue;
        let bytes: Uint8Array | undefined;
        if (part.data instanceof Uint8Array) {
          bytes = part.data;
        } else if (typeof part.data === "string") {
          bytes = Buffer.from(part.data, "base64");
        } else if (part.data.protocol === "data:") {
          const encoded = part.data.href.split(",", 2)[1];
          if (encoded) bytes = Buffer.from(encoded, "base64");
        }
        if (bytes) {
          images.push({
            bytes,
            mimeType: part.mediaType,
            filename: part.filename ?? `image-${images.length + 1}`,
          });
        }
      }
      continue;
    }
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "text") {
          transcript.push(`[OpenCode assistant]\n${part.text}`);
        } else if (part.type === "reasoning") {
          transcript.push(`[OpenCode assistant reasoning]\n${part.text}`);
        } else if (part.type === "tool-call") {
          transcript.push(
            `[OpenCode tool call id=${part.toolCallId} name=${part.toolName}]\n${stringify(part.input)}`,
          );
        } else if (part.type === "tool-result") {
          const content = toolResultText(part);
          toolResults.push({
            toolCallId: part.toolCallId,
            content,
            isError: toolResultIsError(part),
          });
          transcript.push(
            `[OpenCode tool result id=${part.toolCallId} name=${part.toolName}]\n${content}`,
          );
        }
      }
      continue;
    }
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      const content = toolResultText(part);
      toolResults.push({
        toolCallId: part.toolCallId,
        content,
        isError: toolResultIsError(part),
      });
      if (messageIndex >= continuationStart) {
        continuationToolResults.push(toolResults.at(-1)!);
      }
      transcript.push(
        `[OpenCode tool result id=${part.toolCallId} name=${part.toolName}]\n${content}`,
      );
    }
  }

  return {
    systemPrompt: system.join("\n") || "You are a helpful assistant.",
    userText: transcript.join("\n\n"),
    images,
    toolResults,
    continuationToolResults,
  };
}

function compileTools(
  tools: LanguageModelV3CallOptions["tools"],
  toolChoice: LanguageModelV3CallOptions["toolChoice"],
): OpenAIToolDef[] {
  if (toolChoice?.type === "none") return [];
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

function usage(promptTokens: number, outputTokens: number): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: promptTokens || undefined,
      noCache: promptTokens || undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTokens || undefined,
      text: undefined,
      reasoning: undefined,
    },
  };
}

export function createCursorLanguageModel(options: CursorLanguageModelOptions): LanguageModelV3 {
  const doStream: LanguageModelV3["doStream"] = async (call) => {
    const prompt = compilePrompt(call.prompt);
    const tools = compileTools(call.tools, call.toolChoice);
    const warnings: SharedV3Warning[] = [];
    if (call.toolChoice?.type === "required" || call.toolChoice?.type === "tool") {
      warnings.push({
        type: "unsupported",
        feature: "toolChoice",
        details: "Cursor AgentService chooses tools internally.",
      });
    }
    let cursorStream = resumeCursorAgent(
      prompt.continuationToolResults,
      prompt.systemPrompt,
      prompt.userText,
      options.selection,
      tools,
      call.abortSignal,
    );
    if (!cursorStream) {
      discardCursorAgent(prompt.toolResults);
      cursorStream = runCursorAgent({
        accessToken: await options.getAccessToken(),
        selection: options.selection,
        systemPrompt: prompt.systemPrompt,
        userText: prompt.userText,
        images: prompt.images,
        tools,
        workspaceRoot: extractWorkspaceRoot(prompt.systemPrompt),
        abortSignal: call.abortSignal,
        apiUrl: options.apiUrl,
      });
    }
    let openBlock:
      | { type: "text" | "reasoning"; id: string }
      | undefined;
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
    const ensureBlock = (
      type: "text" | "reasoning",
      controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
    ) => {
      if (openBlock?.type === type) return openBlock.id;
      closeBlock(controller);
      const id = `${type}-${crypto.randomUUID()}`;
      openBlock = { type, id };
      controller.enqueue({
        type: type === "text" ? "text-start" : "reasoning-start",
        id,
      });
      return id;
    };

    return {
      stream: cursorStream.pipeThrough(new TransformStream<CursorRunEvent, LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings });
        },
        transform(event, controller) {
          if (event.type === "text") {
            const id = ensureBlock("text", controller);
            controller.enqueue({ type: "text-delta", id, delta: event.text });
            return;
          }
          if (event.type === "reasoning") {
            const id = ensureBlock("reasoning", controller);
            controller.enqueue({ type: "reasoning-delta", id, delta: event.text });
            return;
          }
          if (event.type === "tool-call") {
            closeBlock(controller);
            controller.enqueue({
              type: "tool-call",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: event.input,
            });
            return;
          }
          if (event.type === "error") {
            closeBlock(controller);
            controller.enqueue({ type: "error", error: event.error });
            return;
          }
          closeBlock(controller);
          controller.enqueue({
            type: "finish",
            usage: usage(event.promptTokens, event.outputTokens),
            finishReason: { unified: event.reason, raw: event.reason },
          });
        },
      })),
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
      let finalUsage = emptyUsage();
      let finishReason: LanguageModelV3FinishReason = {
        unified: "other",
        raw: undefined,
      };
      let warnings: SharedV3Warning[] = [];
      for await (const part of result.stream) {
        if (part.type === "stream-start") warnings = part.warnings;
        if (part.type === "text-delta") content.push({ type: "text", text: part.delta });
        if (part.type === "reasoning-delta") content.push({ type: "reasoning", text: part.delta });
        if (part.type === "tool-call") content.push(part);
        if (part.type === "error") throw part.error;
        if (part.type === "finish") {
          finalUsage = part.usage;
          finishReason = part.finishReason;
        }
      }
      return { content, usage: finalUsage, finishReason, warnings };
    },
  };
}

type LanguageContext = Pick<Plugin.Context, "aisdk" | "session">;

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
): Promise<DisposableRegistration> {
  const providerID = Provider.ID.make(CURSOR_INTEGRATION_ID);
  const session = await context.session.hook(
    "context",
    (event) => {
      event.messages = event.messages.map((message) => ({
        ...message,
        content: message.content.map((part) => {
          if (part.type !== "tool-result" || part.result.type !== "error") return part;
          const cursor = record(part.providerMetadata?.cursor);
          return {
            ...part,
            providerMetadata: {
              ...part.providerMetadata,
              cursor: { ...cursor, toolResultError: true },
            },
          };
        }),
      }));
    },
    { providerID },
  );
  let sdk: DisposableRegistration | undefined;
  let language: DisposableRegistration | undefined;
  try {
    sdk = await context.aisdk.hook(
      "sdk",
      (event) => {
        event.sdk = {
          languageModel() {
            throw new Error("Cursor language hook was not installed");
          },
        };
      },
      { providerID },
    );
    language = await context.aisdk.hook(
      "language",
      (event) => {
        const encoded = event.model.headers?.[CURSOR_SELECTION_HEADER];
        const selection = decodeCursorModelSelection(encoded) ??
          literalCursorModelSelection(event.model.modelID ?? event.model.id);
        event.language = createCursorLanguageModel({
          modelId: event.model.id,
          selection,
          getAccessToken,
        });
      },
      { providerID },
    );
  } catch (error) {
    await disposeRegistrations([
      ...(sdk ? [sdk] : []),
      session,
    ]).catch(() => undefined);
    throw error;
  }
  return {
    async dispose() {
      await disposeRegistrations([language, sdk, session]);
    },
  };
}
