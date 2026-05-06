import { beforeEach, describe, expect, mock, test } from "bun:test";

type UnaryResult = { body: Uint8Array; exitCode: number; timedOut: boolean };

const requestSchemaPath = "../../src/proto/agent_pb";
const modelsModulePath = "../../src/models";
const proxyModulePath = "../../src/proxy";

async function buildUsableModelsPayload(models: unknown[]): Promise<Uint8Array> {
  const { create, toBinary } = await import("@bufbuild/protobuf");
  const { GetUsableModelsResponseSchema } = await import(requestSchemaPath);
  const message = create(GetUsableModelsResponseSchema, { models });
  return toBinary(GetUsableModelsResponseSchema, message);
}

describe("models normalization helpers", () => {
  test("normalizeSingleModel returns normalized model for valid input", async () => {
    const { normalizeSingleModel } = await import(modelsModulePath);
    const model = normalizeSingleModel({
      modelId: " claude-4.5-sonnet ",
      displayName: " Claude 4.5 Sonnet ",
      aliases: ["unused alias"],
    });

    expect(model).not.toBeNull();
    expect(model?.id).toBe("claude-4.5-sonnet");
    expect(model?.name).toBe("Claude 4.5 Sonnet");
    expect(model?.reasoning).toBe(false);
    expect(model?.contextWindow).toBe(200_000);
    expect(model?.maxTokens).toBe(64_000);
  });

  test("normalizeSingleModel returns null when required fields are missing", async () => {
    const { normalizeSingleModel } = await import(modelsModulePath);
    expect(normalizeSingleModel({ displayName: "No model id" })).toBeNull();
  });

  test("normalizeSingleModel returns null for empty modelId", async () => {
    const { normalizeSingleModel } = await import(modelsModulePath);
    expect(normalizeSingleModel({ modelId: "   " })).toBeNull();
  });

  test("normalizeSingleModel toggles reasoning by thinkingDetails presence", async () => {
    const { normalizeSingleModel } = await import(modelsModulePath);
    const withoutThinking = normalizeSingleModel({ modelId: "gpt-5.2" });
    const withThinking = normalizeSingleModel({
      modelId: "gpt-5.2",
      thinkingDetails: { budget: 1 },
    });

    expect(withoutThinking?.reasoning).toBe(false);
    expect(withThinking?.reasoning).toBe(true);
  });

  test("pickDisplayName respects display field priority", async () => {
    const { pickDisplayName } = await import(modelsModulePath);
    expect(
      pickDisplayName(
        {
          modelId: "m",
          displayName: "primary",
          displayNameShort: "short",
          displayModelId: "display-id",
          aliases: ["alias-1"],
        },
        "fallback",
      ),
    ).toBe("primary");

    expect(
      pickDisplayName(
        {
          modelId: "m",
          displayNameShort: "short",
          displayModelId: "display-id",
          aliases: ["alias-1"],
        },
        "fallback",
      ),
    ).toBe("short");

    expect(
      pickDisplayName(
        {
          modelId: "m",
          displayModelId: "display-id",
          aliases: ["alias-1"],
        },
        "fallback",
      ),
    ).toBe("display-id");

    expect(
      pickDisplayName(
        {
          modelId: "m",
          aliases: ["alias-1", "alias-2"],
        },
        "fallback",
      ),
    ).toBe("alias-1");

    expect(
      pickDisplayName(
        {
          modelId: "m",
          aliases: ["   "],
        },
        "fallback",
      ),
    ).toBe("fallback");
  });
});

describe("clearModelCache", () => {
  beforeEach(() => {
    mock.restore();
  });

  test("resets cached discovered models", async () => {
    const firstPayload = await buildUsableModelsPayload([
      { modelId: "cached-model-a", displayName: "Cached A" },
    ]);
    const secondPayload = await buildUsableModelsPayload([
      { modelId: "cached-model-b", displayName: "Cached B" },
    ]);

    let callCount = 0;
    mock.module(proxyModulePath, () => ({
      callCursorUnaryRpc: async (): Promise<UnaryResult> => {
        callCount += 1;
        return {
          body: callCount === 1 ? firstPayload : secondPayload,
          exitCode: 0,
          timedOut: false,
        };
      },
    }));

    const modelsMod = await import(`${modelsModulePath}?cache-reset=${Date.now()}`);

    const first = await modelsMod.getCursorModels("token");
    const second = await modelsMod.getCursorModels("token");
    expect(first.map((m: { id: string }) => m.id)).toEqual(["cached-model-a"]);
    expect(second.map((m: { id: string }) => m.id)).toEqual(["cached-model-a"]);
    expect(callCount).toBe(1);

    modelsMod.clearModelCache();
    const third = await modelsMod.getCursorModels("token");
    expect(third.map((m: { id: string }) => m.id)).toEqual(["cached-model-b"]);
    expect(callCount).toBe(2);
  });
});
