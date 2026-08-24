import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { startTestCursorBackend, type TestCursorBackend } from "./fixtures/cursor-backend";
import { encodeCursorModelSelection } from "../src/model-selection";

let backend: TestCursorBackend;

beforeAll(async () => {
  backend = await startTestCursorBackend();
});

afterAll(async () => {
  await backend.close();
});

afterEach(async () => {
  const { stopCursorTransport } = await import("../src/cursor-agent");
  stopCursorTransport();
});

async function collect(stream: ReadableStream<LanguageModelV3StreamPart>) {
  const parts: LanguageModelV3StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

describe("native Cursor LanguageModelV3 adapter", () => {
  test("registers provider-scoped SDK and language hooks", async () => {
    const hooks = new Map<string, (event: any) => void>();
    let contextHook: ((event: any) => void) | undefined;
    const disposed: string[] = [];
    const { registerCursorLanguage } = await import("../src/opencode/language");
    const registration = await registerCursorLanguage({
      aisdk: {
        hook: async (name: string, callback: (event: any) => void, options: unknown) => {
          expect(options).toEqual({ providerID: "cursor" });
          hooks.set(name, callback);
          return { dispose: async () => { disposed.push(name); } };
        },
      },
      session: {
        hook: async (name: string, callback: (event: any) => void, options: unknown) => {
          expect(name).toBe("context");
          expect(options).toEqual({ providerID: "cursor" });
          contextHook = callback;
          return { dispose: async () => { disposed.push(name); } };
        },
      },
    } as never, async () => "token");
    const selection = {
      publicId: "composer-2",
      modelId: "composer-2-fast",
      displayName: "Composer 2 Fast",
      parameters: [{ id: "speed", value: "fast" }],
      maxMode: false,
    };
    const event = {
      model: {
        providerID: "cursor",
        id: "composer-2",
        modelID: "composer-2",
        headers: {
          "x-opencode-cursor-selection": encodeCursorModelSelection(selection),
        },
      },
      options: {},
      sdk: undefined,
      language: undefined,
    };

    hooks.get("sdk")?.(event);
    hooks.get("language")?.(event);
    const contextEvent: any = {
      messages: [{
        role: "tool",
        content: [{
          type: "tool-result",
          id: "call-1",
          name: "write",
          result: { type: "error", value: "permission denied" },
        }],
      }],
    };
    contextHook?.(contextEvent);

    expect(typeof event.sdk?.languageModel).toBe("function");
    expect(event.language?.modelId).toBe("composer-2");
    expect(contextEvent.messages[0]?.content[0]?.providerMetadata).toEqual({
      cursor: { toolResultError: true },
    });
    await registration.dispose();
    expect(disposed).toEqual(["language", "sdk", "context"]);
  });

  test("rolls back the context hook when AI SDK registration fails", async () => {
    const disposed: string[] = [];
    const { registerCursorLanguage } = await import("../src/opencode/language");

    await expect(registerCursorLanguage({
      session: {
        hook: async () => ({
          dispose: async () => { disposed.push("context"); },
        }),
      },
      aisdk: {
        hook: async () => {
          throw new Error("SDK hook failed");
        },
      },
    } as never, async () => "token")).rejects.toThrow("SDK hook failed");

    expect(disposed).toEqual(["context"]);
  });

  test("continues a tool loop on the parked AgentService Run", async () => {
    backend.setRunMode("native-tool-loop");
    const { createCursorLanguageModel } = await import("../src/opencode/language");
    const model = createCursorLanguageModel({
      modelId: "composer-2",
      selection: {
        publicId: "composer-2",
        modelId: "composer-2",
        displayName: "Composer 2",
        parameters: [],
        maxMode: false,
      },
      getAccessToken: async () => "test-token",
      apiUrl: backend.apiUrl,
    });
    const tools: NonNullable<LanguageModelV3CallOptions["tools"]> = [{
      type: "function",
      name: "read",
      description: "Read a file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    }];

    const first = await model.doStream({
      prompt: [
        { role: "system", content: "You are a coding agent." },
        { role: "user", content: [{ type: "text", text: "Read the file." }] },
      ],
      tools,
    });
    const firstParts = await collect(first.stream);
    const toolCall = firstParts.find((part) => part.type === "tool-call");
    const toolOutput = `file contents\n${"x".repeat(30_000)}`;
    expect(toolCall).toMatchObject({
      type: "tool-call",
      toolName: "read",
      input: "{}",
    });
    expect(firstParts.at(-1)).toMatchObject({
      type: "finish",
      finishReason: { unified: "tool-calls" },
    });

    const second = await model.doStream({
      prompt: [
        { role: "system", content: "You are a coding agent." },
        { role: "user", content: [{ type: "text", text: "Read the file." }] },
        {
          role: "assistant",
          content: [{
            type: "tool-call",
            toolCallId: toolCall?.type === "tool-call" ? toolCall.toolCallId : "missing",
            toolName: "read",
            input: {},
          }],
        },
        {
          role: "tool",
          content: [{
            type: "tool-result",
            toolCallId: toolCall?.type === "tool-call" ? toolCall.toolCallId : "missing",
            toolName: "read",
            output: { type: "text", value: toolOutput },
          }],
        },
      ],
      tools,
    });
    const secondParts = await collect(second.stream);

    expect(backend.getRunRequestCount()).toBe(1);
    expect(secondParts).toContainEqual(expect.objectContaining({
      type: "text-delta",
      delta: "continued on parked Run",
    }));
    expect(secondParts.at(-1)).toMatchObject({
      type: "finish",
      finishReason: { unified: "stop" },
    });
    const firstFinish = firstParts.find((part) => part.type === "finish");
    const secondFinish = secondParts.find((part) => part.type === "finish");
    const firstInput = firstFinish?.type === "finish"
      ? firstFinish.usage.inputTokens.total ?? 0
      : 0;
    const secondInput = secondFinish?.type === "finish"
      ? secondFinish.usage.inputTokens.total ?? 0
      : 0;
    expect(secondInput).toBeGreaterThan(firstInput);
  });

  test("preserves OpenCode tool failures in Cursor MCP results", async () => {
    backend.setRunMode("native-tool-loop");
    const { createCursorLanguageModel } = await import("../src/opencode/language");
    const model = createCursorLanguageModel({
      modelId: "composer-2",
      selection: {
        publicId: "composer-2",
        modelId: "composer-2",
        displayName: "Composer 2",
        parameters: [],
        maxMode: false,
      },
      getAccessToken: async () => "test-token",
      apiUrl: backend.apiUrl,
    });
    const tools: NonNullable<LanguageModelV3CallOptions["tools"]> = [{
      type: "function",
      name: "read",
      inputSchema: { type: "object" },
    }];
    const first = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Read the file." }] }],
      tools,
    });
    const firstParts = await collect(first.stream);
    const toolCall = firstParts.find((part) => part.type === "tool-call");

    const second = await model.doStream({
      prompt: [
        { role: "user", content: [{ type: "text", text: "Read the file." }] },
        {
          role: "assistant",
          content: [{
            type: "tool-call",
            toolCallId: toolCall?.type === "tool-call" ? toolCall.toolCallId : "missing",
            toolName: "read",
            input: {},
          }],
        },
        {
          role: "tool",
          content: [{
            type: "tool-result",
            toolCallId: toolCall?.type === "tool-call" ? toolCall.toolCallId : "missing",
            toolName: "read",
            output: { type: "text", value: "permission denied" },
            providerOptions: { cursor: { toolResultError: true } },
          }],
        },
      ],
      tools,
    });
    await collect(second.stream);

    expect(backend.getRunToolResultErrors()).toEqual([true]);
  });

  test("starts a fresh Run when a steering message follows tool results", async () => {
    backend.setRunMode("native-tool-loop");
    const { createCursorLanguageModel } = await import("../src/opencode/language");
    const model = createCursorLanguageModel({
      modelId: "composer-2",
      selection: {
        publicId: "composer-2",
        modelId: "composer-2",
        displayName: "Composer 2",
        parameters: [],
        maxMode: false,
      },
      getAccessToken: async () => "test-token",
      apiUrl: backend.apiUrl,
    });
    const tools: NonNullable<LanguageModelV3CallOptions["tools"]> = [{
      type: "function",
      name: "read",
      inputSchema: { type: "object" },
    }];
    const first = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Read the file." }] }],
      tools,
    });
    const firstParts = await collect(first.stream);
    const toolCall = firstParts.find((part) => part.type === "tool-call");

    const second = await model.doStream({
      prompt: [
        { role: "user", content: [{ type: "text", text: "Read the file." }] },
        {
          role: "assistant",
          content: [{
            type: "tool-call",
            toolCallId: toolCall?.type === "tool-call" ? toolCall.toolCallId : "missing",
            toolName: "read",
            input: {},
          }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "Stop and explain instead." }],
        },
        {
          role: "tool",
          content: [{
            type: "tool-result",
            toolCallId: toolCall?.type === "tool-call" ? toolCall.toolCallId : "missing",
            toolName: "read",
            output: { type: "text", value: "file contents" },
          }],
        },
      ],
      tools,
    });
    await collect(second.stream);

    expect(backend.getRunRequestCount()).toBe(2);
    expect(backend.getRunUserTexts()[1]).toContain("Stop and explain instead.");
  });

  test("uses generic instructions when no tools are available", async () => {
    const { cursorToolInstructions } = await import("../src/cursor-agent");

    const instructions = cursorToolInstructions(true);

    expect(instructions).toContain("No tools are available");
    expect(instructions).not.toContain("summary/compaction");
  });

  test("maps reasoning, text, and images through valid V3 blocks", async () => {
    backend.setRunMode("reasoning-text");
    const { createCursorLanguageModel } = await import("../src/opencode/language");
    const model = createCursorLanguageModel({
      modelId: "composer-2",
      selection: {
        publicId: "composer-2",
        modelId: "composer-2",
        displayName: "Composer 2",
        parameters: [],
        maxMode: false,
      },
      getAccessToken: async () => "test-token",
      apiUrl: backend.apiUrl,
    });
    const result = await model.doStream({
      prompt: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this image." },
          {
            type: "file",
            data: new Uint8Array([1, 2, 3]),
            mediaType: "image/png",
            filename: "sample.png",
          },
        ],
      }],
    });
    const parts = await collect(result.stream);

    expect(backend.getRunImageCounts()).toEqual([1]);
    expect(parts.map((part) => part.type)).toEqual([
      "stream-start",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
    const finish = parts.find((part) => part.type === "finish");
    expect(
      finish?.type === "finish" ? finish.usage.inputTokens.total : undefined,
    ).toBeGreaterThan(0);
  });

  test("preserves stream warnings in doGenerate", async () => {
    backend.setRunMode("reasoning-text");
    const { createCursorLanguageModel } = await import("../src/opencode/language");
    const model = createCursorLanguageModel({
      modelId: "composer-2",
      selection: {
        publicId: "composer-2",
        modelId: "composer-2",
        displayName: "Composer 2",
        parameters: [],
        maxMode: false,
      },
      getAccessToken: async () => "test-token",
      apiUrl: backend.apiUrl,
    });

    const result = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Answer." }] }],
      tools: [{ type: "function", name: "read", inputSchema: { type: "object" } }],
      toolChoice: { type: "required" },
    });

    expect(result.warnings).toContainEqual(expect.objectContaining({
      type: "unsupported",
      feature: "toolChoice",
    }));
  });

  test("keeps sequential tools on one AgentService Run", async () => {
    backend.setRunMode("native-multi-tool-loop");
    const { createCursorLanguageModel } = await import("../src/opencode/language");
    const model = createCursorLanguageModel({
      modelId: "composer-2",
      selection: {
        publicId: "composer-2",
        modelId: "composer-2",
        displayName: "Composer 2",
        parameters: [],
        maxMode: false,
      },
      getAccessToken: async () => "test-token",
      apiUrl: backend.apiUrl,
    });
    const tools: NonNullable<LanguageModelV3CallOptions["tools"]> = [
      { type: "function", name: "write", inputSchema: { type: "object" } },
      { type: "function", name: "read", inputSchema: { type: "object" } },
    ];
    const prompt: LanguageModelV3CallOptions["prompt"] = [
      { role: "user", content: [{ type: "text", text: "Write, then read." }] },
    ];

    const first = await model.doStream({ prompt, tools });
    const firstParts = await collect(first.stream);
    const write = firstParts.find((part) => part.type === "tool-call");
    expect(write).toMatchObject({ type: "tool-call", toolName: "write" });

    const secondPrompt: LanguageModelV3CallOptions["prompt"] = [
      ...prompt,
      {
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: write?.type === "tool-call" ? write.toolCallId : "missing",
          toolName: "write",
          input: {},
        }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: write?.type === "tool-call" ? write.toolCallId : "missing",
          toolName: "write",
          output: { type: "text", value: "write succeeded" },
        }],
      },
    ];
    const second = await model.doStream({ prompt: secondPrompt, tools });
    const secondParts = await collect(second.stream);
    const read = secondParts.find((part) => part.type === "tool-call");
    expect(read).toMatchObject({ type: "tool-call", toolName: "read" });

    const third = await model.doStream({
      prompt: [
        ...secondPrompt,
        {
          role: "assistant",
          content: [{
            type: "tool-call",
            toolCallId: read?.type === "tool-call" ? read.toolCallId : "missing",
            toolName: "read",
            input: {},
          }],
        },
        {
          role: "tool",
          content: [{
            type: "tool-result",
            toolCallId: read?.type === "tool-call" ? read.toolCallId : "missing",
            toolName: "read",
            output: { type: "text", value: "read succeeded" },
          }],
        },
      ],
      tools,
    });
    const thirdParts = await collect(third.stream);

    expect(backend.getRunRequestCount()).toBe(1);
    expect(thirdParts).toContainEqual(expect.objectContaining({
      type: "text-delta",
      delta: "completed multi-tool Run",
    }));
  });

  test("collects delayed parallel tool calls before ending the Run", async () => {
    backend.setRunMode("native-parallel-tool-loop");
    const { createCursorLanguageModel } = await import("../src/opencode/language");
    const model = createCursorLanguageModel({
      modelId: "composer-2",
      selection: {
        publicId: "composer-2",
        modelId: "composer-2",
        displayName: "Composer 2",
        parameters: [],
        maxMode: false,
      },
      getAccessToken: async () => "test-token",
      apiUrl: backend.apiUrl,
    });
    const tools: NonNullable<LanguageModelV3CallOptions["tools"]> = [
      { type: "function", name: "read", inputSchema: { type: "object" } },
      { type: "function", name: "grep", inputSchema: { type: "object" } },
    ];
    const first = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Inspect both." }] }],
      tools,
    });
    const firstParts = await collect(first.stream);
    const calls = firstParts.filter((part) => part.type === "tool-call");

    expect(calls.map((call) => call.toolName)).toEqual(["read", "grep"]);
    expect(firstParts.at(-1)).toMatchObject({
      type: "finish",
      finishReason: { unified: "tool-calls" },
    });

    const second = await model.doStream({
      prompt: [
        { role: "user", content: [{ type: "text", text: "Inspect both." }] },
        {
          role: "assistant",
          content: calls.map((call) => ({
            type: "tool-call" as const,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input: {},
          })),
        },
        {
          role: "tool",
          content: calls.map((call) => ({
            type: "tool-result" as const,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: { type: "text" as const, value: `${call.toolName} result` },
          })),
        },
      ],
      tools,
    });
    const secondParts = await collect(second.stream);

    expect(backend.getRunRequestCount()).toBe(1);
    expect(secondParts).toContainEqual(expect.objectContaining({
      type: "text-delta",
      delta: "continued after parallel tools",
    }));
  });

  test("abandons a parked Run when a parallel result batch is incomplete", async () => {
    backend.setRunMode("native-parallel-tool-loop");
    const { createCursorLanguageModel } = await import("../src/opencode/language");
    const model = createCursorLanguageModel({
      modelId: "composer-2",
      selection: {
        publicId: "composer-2",
        modelId: "composer-2",
        displayName: "Composer 2",
        parameters: [],
        maxMode: false,
      },
      getAccessToken: async () => "test-token",
      apiUrl: backend.apiUrl,
    });
    const tools: NonNullable<LanguageModelV3CallOptions["tools"]> = [
      { type: "function", name: "read", inputSchema: { type: "object" } },
      { type: "function", name: "grep", inputSchema: { type: "object" } },
    ];
    const first = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Inspect both." }] }],
      tools,
    });
    const firstParts = await collect(first.stream);
    const call = firstParts.find((part) => part.type === "tool-call");

    const second = await model.doStream({
      prompt: [
        { role: "user", content: [{ type: "text", text: "Inspect both." }] },
        {
          role: "assistant",
          content: call?.type === "tool-call" ? [call] : [],
        },
        {
          role: "tool",
          content: call?.type === "tool-call" ? [{
            type: "tool-result",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: { type: "text", value: "partial result" },
          }] : [],
        },
      ],
      tools,
    });
    await collect(second.stream);

    expect(backend.getRunRequestCount()).toBe(2);
  });

  test("abandons a parked Run when a parallel call arrives after settling", async () => {
    backend.setRunMode("native-parallel-tool-loop");
    process.env.OPENCODE_CURSOR_NATIVE_TOOL_SETTLE_MS = "50";
    try {
      const { createCursorLanguageModel } = await import("../src/opencode/language");
      const model = createCursorLanguageModel({
        modelId: "composer-2",
        selection: {
          publicId: "composer-2",
          modelId: "composer-2",
          displayName: "Composer 2",
          parameters: [],
          maxMode: false,
        },
        getAccessToken: async () => "test-token",
        apiUrl: backend.apiUrl,
      });
      const tools: NonNullable<LanguageModelV3CallOptions["tools"]> = [
        { type: "function", name: "read", inputSchema: { type: "object" } },
        { type: "function", name: "grep", inputSchema: { type: "object" } },
      ];
      const first = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Inspect both." }] }],
        tools,
      });
      const firstParts = await collect(first.stream);
      const call = firstParts.find((part) => part.type === "tool-call");
      await Bun.sleep(100);

      const second = await model.doStream({
        prompt: [
          { role: "user", content: [{ type: "text", text: "Inspect both." }] },
          { role: "assistant", content: call?.type === "tool-call" ? [call] : [] },
          {
            role: "tool",
            content: call?.type === "tool-call" ? [{
              type: "tool-result",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: { type: "text", value: "partial result" },
            }] : [],
          },
        ],
        tools,
      });
      await collect(second.stream);

      expect(backend.getRunRequestCount()).toBe(2);
    } finally {
      delete process.env.OPENCODE_CURSOR_NATIVE_TOOL_SETTLE_MS;
    }
  });

  test("starts a fresh Run when the selected model changes", async () => {
    backend.setRunMode("native-tool-loop");
    const { createCursorLanguageModel } = await import("../src/opencode/language");
    const selection = {
      publicId: "composer-2",
      modelId: "composer-2",
      displayName: "Composer 2",
      parameters: [],
      maxMode: false,
    };
    const model = createCursorLanguageModel({
      modelId: "composer-2",
      selection,
      getAccessToken: async () => "test-token",
      apiUrl: backend.apiUrl,
    });
    const tools: NonNullable<LanguageModelV3CallOptions["tools"]> = [{
      type: "function",
      name: "read",
      inputSchema: { type: "object" },
    }];
    const first = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Read it." }] }],
      tools,
    });
    const firstParts = await collect(first.stream);
    const call = firstParts.find((part) => part.type === "tool-call");
    const changedModel = createCursorLanguageModel({
      modelId: "composer-2",
      selection: { ...selection, modelId: "composer-2-fast", parameters: [{ id: "speed", value: "fast" }] },
      getAccessToken: async () => "test-token",
      apiUrl: backend.apiUrl,
    });

    const second = await changedModel.doStream({
      prompt: [
        { role: "user", content: [{ type: "text", text: "Read it." }] },
        { role: "assistant", content: call?.type === "tool-call" ? [call] : [] },
        {
          role: "tool",
          content: call?.type === "tool-call" ? [{
            type: "tool-result",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: { type: "text", value: "contents" },
          }] : [],
        },
      ],
      tools,
    });
    await collect(second.stream);

    expect(backend.getRunRequestCount()).toBe(2);
    expect(backend.getRunSelections()[1]?.modelId).toBe("composer-2-fast");
  });

  test("evicts an abandoned parked Run when native capacity is reached", async () => {
    backend.setRunMode("native-tool-loop");
    process.env.OPENCODE_CURSOR_MAX_ACTIVE_RUNS = "1";
    try {
      const {
        createCursorLanguageModel,
      } = await import("../src/opencode/language");
      const {
        nativeCursorTransportStats,
      } = await import("../src/cursor-agent");
      const model = createCursorLanguageModel({
        modelId: "composer-2",
        selection: {
          publicId: "composer-2",
          modelId: "composer-2",
          displayName: "Composer 2",
          parameters: [],
          maxMode: false,
        },
        getAccessToken: async () => "test-token",
        apiUrl: backend.apiUrl,
      });
      const tools: NonNullable<LanguageModelV3CallOptions["tools"]> = [{
        type: "function",
        name: "read",
        inputSchema: { type: "object" },
      }];
      const first = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Read one." }] }],
        tools,
      });
      await collect(first.stream);
      expect(nativeCursorTransportStats().parked).toBe(1);

      const second = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Start over." }] }],
        tools,
      });
      await collect(second.stream);

      expect(backend.getRunRequestCount()).toBe(2);
      expect(nativeCursorTransportStats().parked).toBe(0);
    } finally {
      const { stopCursorTransport } = await import("../src/cursor-agent");
      stopCursorTransport();
      delete process.env.OPENCODE_CURSOR_MAX_ACTIVE_RUNS;
    }
  });

  test("rejects the stream when OpenCode aborts a Run", async () => {
    backend.setRunMode("heartbeat-only-stall");
    const { createCursorLanguageModel } = await import("../src/opencode/language");
    const model = createCursorLanguageModel({
      modelId: "composer-2",
      selection: {
        publicId: "composer-2",
        modelId: "composer-2",
        displayName: "Composer 2",
        parameters: [],
        maxMode: false,
      },
      getAccessToken: async () => "test-token",
      apiUrl: backend.apiUrl,
    });
    const abort = new AbortController();
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Wait." }] }],
      abortSignal: abort.signal,
    });
    const reader = result.stream.getReader();
    expect((await reader.read()).value).toMatchObject({ type: "stream-start" });

    abort.abort(new DOMException("Stopped", "AbortError"));

    await expect(reader.read()).rejects.toThrow("Stopped");
  });

  test("settles an active stream when the transport stops", async () => {
    backend.setRunMode("heartbeat-only-stall");
    const { createCursorLanguageModel } = await import("../src/opencode/language");
    const { stopCursorTransport } = await import("../src/cursor-agent");
    const model = createCursorLanguageModel({
      modelId: "composer-2",
      selection: {
        publicId: "composer-2",
        modelId: "composer-2",
        displayName: "Composer 2",
        parameters: [],
        maxMode: false,
      },
      getAccessToken: async () => "test-token",
      apiUrl: backend.apiUrl,
    });
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Wait." }] }],
    });
    const collecting = collect(result.stream);
    await Bun.sleep(25);

    stopCursorTransport();

    const parts = await collecting;
    expect(parts).toContainEqual(expect.objectContaining({
      type: "error",
      error: expect.objectContaining({ message: expect.stringContaining("exited") }),
    }));
  });

  test("fails a heartbeat-only Run after the native pre-output timeout", async () => {
    backend.setRunMode("heartbeat-only-stall");
    process.env.OPENCODE_CURSOR_PRE_OUTPUT_STALL_TIMEOUT_MS = "100";
    const abort = new AbortController();
    try {
      const { createCursorLanguageModel } = await import("../src/opencode/language");
      const model = createCursorLanguageModel({
        modelId: "composer-2",
        selection: {
          publicId: "composer-2",
          modelId: "composer-2",
          displayName: "Composer 2",
          parameters: [],
          maxMode: false,
        },
        getAccessToken: async () => "test-token",
        apiUrl: backend.apiUrl,
      });
      const result = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Wait." }] }],
        abortSignal: abort.signal,
      });
      const parts = await Promise.race([
        collect(result.stream),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("native stall timeout did not fire")), 1_000);
        }),
      ]);

      expect(parts).toContainEqual(expect.objectContaining({
        type: "error",
        error: expect.objectContaining({ message: expect.stringContaining("stalled") }),
      }));
    } finally {
      abort.abort();
      delete process.env.OPENCODE_CURSOR_PRE_OUTPUT_STALL_TIMEOUT_MS;
    }
  });

  test("fails a Run that stalls after visible output", async () => {
    backend.setRunMode("text-then-hang");
    process.env.OPENCODE_CURSOR_STALL_TIMEOUT_MS = "100";
    const abort = new AbortController();
    try {
      const { createCursorLanguageModel } = await import("../src/opencode/language");
      const model = createCursorLanguageModel({
        modelId: "composer-2",
        selection: {
          publicId: "composer-2",
          modelId: "composer-2",
          displayName: "Composer 2",
          parameters: [],
          maxMode: false,
        },
        getAccessToken: async () => "test-token",
        apiUrl: backend.apiUrl,
      });
      const result = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Answer." }] }],
        abortSignal: abort.signal,
      });
      const parts = await collect(result.stream);

      expect(parts).toContainEqual(expect.objectContaining({
        type: "text-delta",
        delta: "partial...",
      }));
      expect(parts).toContainEqual(expect.objectContaining({
        type: "error",
        error: expect.objectContaining({ message: expect.stringContaining("stalled") }),
      }));
    } finally {
      abort.abort();
      delete process.env.OPENCODE_CURSOR_STALL_TIMEOUT_MS;
    }
  });

  test("fails a resumed Run that stays silent after a tool result", async () => {
    backend.setRunMode("tool-call-then-silent-hang");
    process.env.OPENCODE_CURSOR_POST_TOOL_PRE_OUTPUT_STALL_TIMEOUT_MS = "100";
    const abort = new AbortController();
    try {
      const { createCursorLanguageModel } = await import("../src/opencode/language");
      const model = createCursorLanguageModel({
        modelId: "composer-2",
        selection: {
          publicId: "composer-2",
          modelId: "composer-2",
          displayName: "Composer 2",
          parameters: [],
          maxMode: false,
        },
        getAccessToken: async () => "test-token",
        apiUrl: backend.apiUrl,
      });
      const tools: NonNullable<LanguageModelV3CallOptions["tools"]> = [{
        type: "function",
        name: "bash",
        inputSchema: { type: "object" },
      }];
      const first = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Run it." }] }],
        tools,
        abortSignal: abort.signal,
      });
      const firstParts = await collect(first.stream);
      const call = firstParts.find((part) => part.type === "tool-call");
      const second = await model.doStream({
        prompt: [
          { role: "user", content: [{ type: "text", text: "Run it." }] },
          {
            role: "assistant",
            content: call?.type === "tool-call" ? [call] : [],
          },
          {
            role: "tool",
            content: call?.type === "tool-call" ? [{
              type: "tool-result",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: { type: "text", value: "command completed" },
            }] : [],
          },
        ],
        tools,
        abortSignal: abort.signal,
      });
      const secondParts = await collect(second.stream);

      expect(secondParts).toContainEqual(expect.objectContaining({
        type: "error",
        error: expect.objectContaining({ message: expect.stringContaining("stalled") }),
      }));
    } finally {
      abort.abort();
      delete process.env.OPENCODE_CURSOR_POST_TOOL_PRE_OUTPUT_STALL_TIMEOUT_MS;
    }
  });
});
