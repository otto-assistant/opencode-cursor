import { describe, expect, test } from "bun:test";
import {
  encodeCursorModelSelection,
  type CursorModel,
} from "../src/model-selection";
import {
  createCursorCatalogState,
  registerCursorCatalog,
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

describe("OpenCode V2 Cursor catalog", () => {
  test("registers a native provider with exact model and variant routing", async () => {
    let transform: ((draft: any) => void) | undefined;
    const context = {
      catalog: {
        transform: async (value: (draft: any) => void) => {
          transform = value;
          return { dispose: async () => {} };
        },
      },
    };
    const state = createCursorCatalogState([model]);

    await registerCursorCatalog(context as never, state);

    const provider: Record<string, any> = {};
    const catalogModel: Record<string, any> = { variants: [] };
    transform?.({
      provider: {
        update(id: string, update: (draft: Record<string, any>) => void) {
          expect(id).toBe("cursor");
          update(provider);
        },
      },
      model: {
        update(
          providerID: string,
          modelID: string,
          update: (draft: Record<string, any>) => void,
        ) {
          expect(providerID).toBe("cursor");
          expect(modelID).toBe(model.id);
          update(catalogModel);
        },
      },
    });

    expect(provider).toMatchObject({
      name: "Cursor",
      integrationID: "cursor",
      activation: "auto",
    });
    expect(provider.package).toStartWith("aisdk:file://");
    expect(provider.package).toEndWith("/opencode/provider.js");
    expect(catalogModel).toMatchObject({
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
    let transform: ((draft: any) => void) | undefined;
    const context = {
      catalog: {
        transform: async (value: (draft: any) => void) => {
          transform = value;
          return { dispose: async () => {} };
        },
      },
    };
    const state = createCursorCatalogState([]);
    await registerCursorCatalog(context as never, state);

    const provider: Record<string, any> = {};
    const models = new Map<string, Record<string, any>>();
    transform?.({
      provider: {
        update(_id: string, update: (draft: Record<string, any>) => void) {
          update(provider);
        },
      },
      model: {
        update(
          _providerID: string,
          modelID: string,
          update: (draft: Record<string, any>) => void,
        ) {
          const draft = { variants: [] };
          update(draft);
          models.set(modelID, draft);
        },
      },
    });

    expect(provider.activation).toBe("enabled");
    expect(models.get("connect")).toMatchObject({
      name: "Connect Cursor to load models",
      enabled: true,
      capabilities: {
        tools: false,
        input: ["text"],
        output: ["text"],
      },
    });
  });
});
