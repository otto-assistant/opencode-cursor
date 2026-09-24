import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import type { ProviderEditor } from "@opencode/plugin/promise/provider";
import {
  encodeCursorModelSelection,
  type CursorModel,
} from "../src/model-selection";
import {
  createCursorCatalogState,
  registerCursorCatalog,
  updateCursorCatalogState,
} from "../src/opencode/catalog";

const model: CursorModel = {
  id: "gpt-5",
  name: "GPT-5",
  reasoning: true,
  contextWindow: 200_000,
  maxTokens: 32_000,
  defaultSelection: {
    publicId: "gpt-5",
    modelId: "gpt-5-medium",
    displayName: "GPT-5",
    parameters: [{ id: "effort", value: "medium" }],
    maxMode: false,
  },
  variants: {
    high: {
      publicId: "gpt-5",
      modelId: "gpt-5-high",
      displayName: "GPT-5 High",
      parameters: [{ id: "effort", value: "high" }],
      maxMode: false,
    },
  },
};

function captureProvider() {
  let callback: Parameters<Plugin.Context["provider"]["transform"]>[0] | undefined;
  const unexpected = () => { throw new Error("Expected a complete source definition"); };
  return {
    context: {
      provider: {
        transform: async (value: NonNullable<typeof callback>) => {
          callback = value;
          return { dispose: async () => {} };
        },
      },
    },
    replay() {
      const sources: Parameters<ProviderEditor["add"]>[0][] = [];
      if (!callback) throw new Error("Provider transform was not registered");
      callback({
        add: (source) => { sources.push(source); },
        list: () => [],
        get: unexpected,
        update: unexpected,
        remove: unexpected,
        models: { set: unexpected, update: unexpected, remove: unexpected },
      });
      expect(sources).toHaveLength(1);
      return sources[0]!;
    },
  };
}

describe("OpenCode V2 Cursor catalog", () => {
  test("registers a native provider with exact model and variant routing", async () => {
    const capture = captureProvider();
    await registerCursorCatalog(capture.context, createCursorCatalogState([model]));
    const { info: provider, models } = capture.replay();
    expect(models).toHaveLength(1);
    const catalogModel = models[0]!;

    expect(provider).toMatchObject({
      id: "cursor",
      name: "Cursor",
      integrationID: "cursor",
      activation: "auto",
    });
    expect(provider.package).toStartWith("aisdk:file://");
    expect(provider.package).toEndWith("/opencode/provider.js");
    expect(catalogModel).toMatchObject({
      providerID: "cursor",
      id: model.id,
      name: model.name,
      modelID: model.id,
      capabilities: {
        tools: true,
        input: ["text", "image"],
        output: ["text"],
      },
      headers: {
        "x-opencode-cursor-selection": encodeCursorModelSelection(
          model.defaultSelection,
        ),
      },
      limit: { context: 200_000, output: 32_000 },
    });
    expect(catalogModel.variants).toEqual([
      {
        id: "high",
        headers: {
          "x-opencode-cursor-selection": encodeCursorModelSelection(
            model.variants.high!,
          ),
        },
      },
    ]);
    expect(catalogModel.cost).toEqual([
      {
        input: 1.25,
        output: 10,
        cache: { read: 0.125, write: 0 },
      },
    ]);
  });

  test("keeps disconnected Cursor visible for the connect flow", async () => {
    const capture = captureProvider();
    await registerCursorCatalog(capture.context, createCursorCatalogState([]));
    const { info: provider, models } = capture.replay();

    expect(provider.activation).toBe("enabled");
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "connect",
      name: "Connect Cursor to load models",
      enabled: true,
      capabilities: {
        tools: false,
        input: ["text"],
        output: ["text"],
      },
    });
  });

  test("replaces the source inventory on refresh without mutating prior reads", async () => {
    const capture = captureProvider();
    const state = createCursorCatalogState([]);
    await registerCursorCatalog(capture.context, state);
    const disconnected = capture.replay();
    updateCursorCatalogState(state, [model]);
    const connected = capture.replay();
    expect(connected.models.map((item) => item.id)).toEqual([model.id]);
    expect(disconnected.models.map((item) => item.id)).toEqual(["connect"]);

    updateCursorCatalogState(state, []);
    expect(capture.replay().models.map((item) => item.id)).toEqual(["connect"]);
    expect(connected.models.map((item) => item.id)).toEqual([model.id]);
  });
});
