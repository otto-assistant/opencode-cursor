import { describe, expect, test } from "bun:test";
import { normalizeAvailableModels } from "../src/models/available-normalizer";
import { applyCatalogMetadata } from "../src/models/metadata";
import { publishCursorCatalog } from "../src/models/publish";
import { normalizeCursorModels } from "../src/models/usable-normalizer";
import {
  encodeCursorModelSelection,
  resolveCursorModelSelection,
  selectionForCursorRequest,
} from "../src/model-selection";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
} from "../src/shared/constants";

describe("Cursor model normalization", () => {
  test("uses explicit AvailableModels context variants", () => {
    const models = normalizeAvailableModels([{
      name: "composer-2",
      clientDisplayName: "Composer 2",
      serverModelName: "composer-2",
      parameterDefinitions: [
        {
          id: "context",
          parameterType: {
            enumParameter: {
              values: [
                { value: "128k", displayName: "128K" },
                { value: "1m", displayName: "1M" },
              ],
            },
          },
        },
        {
          id: "reasoning",
          parameterType: {
            enumParameter: {
              values: [{ value: "medium" }, { value: "high" }],
            },
          },
        },
      ],
      variants: [
        {
          parameterValues: [
            { id: "context", value: "128k" },
            { id: "reasoning", value: "medium" },
          ],
          legacySlug: "composer-2-medium",
          isDefaultNonMaxConfig: true,
        },
        {
          parameterValues: [
            { id: "context", value: "128k" },
            { id: "reasoning", value: "high" },
          ],
          legacySlug: "composer-2-high",
        },
        {
          parameterValues: [
            { id: "context", value: "1m" },
            { id: "reasoning", value: "medium" },
          ],
          legacySlug: "composer-2-1m-medium",
          isDefaultMaxConfig: true,
        },
      ],
    }]);

    expect(models.map((model) => [model.id, model.contextWindow])).toEqual([
      ["composer-2", 128_000],
      ["composer-2-1m", 1_000_000],
    ]);
    expect(models[0]?.variants).toHaveProperty("high");
  });

  test("groups live Cursor parameter spellings without splitting the family", () => {
    const models = publishCursorCatalog(
      [{
        name: "gemini-3.8-flash",
        clientDisplayName: "Gemini 3.8 Flash",
        serverModelName: "gemini-3.8-flash",
        parameterDefinitions: [{
          id: "reasoning_effort",
          parameterType: {
            enumParameter: {
              values: [{ value: "low" }, { value: "medium" }, { value: "high" }],
            },
          },
        }],
        variants: ["low", "medium", "high"].map((effort) => ({
          parameterValues: [{ id: "reasoning_effort", value: effort }],
          legacySlug: `gemini-3.8-flash-${effort}`,
        })),
      }, {
        name: "claude-opus-5",
        clientDisplayName: "Claude Opus 5",
        serverModelName: "claude-opus-5",
        parameterDefinitions: [
          {
            id: "thinking",
            parameterType: { booleanParameter: { values: [{ value: "false" }, { value: "true" }] } },
          },
          {
            id: "effort",
            parameterType: {
              enumParameter: { values: [{ value: "low" }, { value: "high" }] },
            },
          },
        ],
        variants: [false, true].flatMap((thinking) =>
          ["low", "high"].map((effort) => ({
            parameterValues: [
              { id: "thinking", value: String(thinking) },
              { id: "effort", value: effort },
            ],
            legacySlug: `claude-opus-5-${thinking ? "thinking-" : ""}${effort}`,
          })),
        ),
      }],
      [],
    );

    expect(models.map((model) => model.id)).toEqual([
      "claude-opus-5",
      "gemini-3.8-flash",
    ]);
    expect(models.find((model) => model.id === "gemini-3.8-flash")?.variants.high?.publicId)
      .toBe("gemini-3.8-flash-high");
    expect(Object.keys(models.find((model) => model.id === "claude-opus-5")?.variants ?? {}).sort())
      .toEqual(["high", "low", "none"]);
  });

  test("groups minimal effort variant and does not create duplicate muse-spark models", () => {
    const models = publishCursorCatalog(
      [{
        name: "muse-spark-1.3",
        clientDisplayName: "Muse Spark 1.3",
        serverModelName: "muse-spark-1.3",
        parameterDefinitions: [{
          id: "effort",
          parameterType: {
            enumParameter: {
              values: [
                { value: "minimal" },
                { value: "low" },
                { value: "high" },
              ],
            },
          },
        }],
        variants: ["minimal", "low", "high"].map((effort) => ({
          parameterValues: [{ id: "effort", value: effort }],
          legacySlug: `muse-spark-1.3-${effort}`,
        })),
      }],
      [
        { modelId: "muse-spark-1.3-minimal", displayName: "Muse Spark 1.3 1M Minimal" },
        { modelId: "muse-spark-1.3-low", displayName: "Muse Spark 1.3 1M Low" },
        { modelId: "muse-spark-1.3-high", displayName: "Muse Spark 1.3 1M" },
      ],
    );

    expect(models.map((m) => m.id)).toEqual(["muse-spark-1.3"]);
    expect(Object.keys(models[0]?.variants ?? {})).toEqual(["minimal", "low", "high"]);
  });

  test("publishes parameterized models from AvailableModels and wire models from GetUsableModels", () => {
    const models = publishCursorCatalog(
      [
        {
          name: "grok-4.7",
          clientDisplayName: "Grok 4.7",
          serverModelName: "grok-4.7",
          parameterDefinitions: [{
            id: "effort",
            parameterType: {
              enumParameter: { values: [{ value: "low" }, { value: "high" }] },
            },
          }],
          variants: ["low", "high"].map((effort) => ({
            parameterValues: [{ id: "effort", value: effort }],
            legacySlug: `grok-4.7-${effort}`,
          })),
        },
        {
          name: "composer-2.5",
          clientDisplayName: "Composer 2.5",
          serverModelName: "composer-2.5",
          variants: [{ legacySlug: "composer-2.5" }],
        },
      ],
      [
        { modelId: "composer-2.5", displayName: "Composer 2.5" },
      ],
    );

    expect(models.map((m) => m.id).sort()).toEqual(["composer-2.5", "grok-4.7"]);
  });

  test("groups Cursor reasoning-effort values as OpenCode variants", () => {
    const models = normalizeAvailableModels([{
      name: "gemini-3.8-flash",
      clientDisplayName: "Gemini 3.8 Flash",
      serverModelName: "gemini-3.8-flash",
      parameterDefinitions: [
        {
          id: "reasoning-effort",
          parameterType: {
            enumParameter: {
              values: [
                { value: "medium", displayName: "Medium" },
                { value: "high", displayName: "High" },
              ],
            },
          },
        },
      ],
      variants: [
        {
          parameterValues: [{ id: "reasoning-effort", value: "medium" }],
          legacySlug: "gemini-3.8-flash",
          isDefaultNonMaxConfig: true,
        },
        {
          parameterValues: [{ id: "reasoning-effort", value: "high" }],
          legacySlug: "gemini-3.8-flash-high",
        },
      ],
    }]);

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      reasoning: true,
    });
    expect(Object.keys(models[0]?.variants ?? {})).toEqual(["medium", "high"]);
    expect(models[0]?.defaultSelection.parameters).toEqual([
      { id: "reasoning-effort", value: "medium" },
    ]);
    expect(models[0]?.variants.high?.parameters).toEqual([
      { id: "reasoning-effort", value: "high" },
    ]);
  });

  test("folds a sibling High catalog name into the base model's variants", () => {
    const models = normalizeAvailableModels([
      {
        name: "gemini-3.7-flash",
        clientDisplayName: "Gemini 3.7 Flash",
        serverModelName: "gemini-3.7-flash",
        parameterDefinitions: [
          {
            id: "reasoning",
            parameterType: {
              enumParameter: {
                values: [{ value: "low" }, { value: "medium" }],
              },
            },
          },
        ],
        variants: [
          {
            parameterValues: [{ id: "reasoning", value: "medium" }],
            legacySlug: "gemini-3.7-flash",
            isDefaultNonMaxConfig: true,
          },
          {
            parameterValues: [{ id: "reasoning", value: "low" }],
            legacySlug: "gemini-3.7-flash-low",
          },
        ],
      },
      {
        name: "gemini-3.7-flash-high",
        clientDisplayName: "Gemini 3.7 Flash",
        serverModelName: "gemini-3.7-flash-high",
      },
    ]);

    expect(models.map((model) => model.id)).toEqual(["gemini-3.7-flash"]);
    expect(Object.keys(models[0]?.variants ?? {}).sort()).toEqual([
      "high",
      "low",
      "medium",
    ]);
    expect(models[0]?.variants.high?.publicId).toBe("gemini-3.7-flash-high");
    expect(models[0]?.defaultSelection.publicId).toBe("gemini-3.7-flash");
  });

  test("keeps grok-4.6 stable and sends the usable wire id", () => {
    const models = publishCursorCatalog(
      [
        {
          name: "grok-4.6",
          clientDisplayName: "Grok 4.6",
          serverModelName: "grok-4.6",
          parameterDefinitions: [{
            id: "effort",
            parameterType: {
              enumParameter: {
                values: [
                  { value: "low" },
                  { value: "medium" },
                  { value: "high" },
                  { value: "xhigh" },
                ],
              },
            },
          }],
          variants: ["low", "medium", "high", "xhigh"].map((effort) => ({
            parameterValues: [{ id: "effort", value: effort }],
            legacySlug: `cursor-grok-4.6-${effort}`,
            isDefaultNonMaxConfig: effort === "high",
          })),
        },
        { name: "cursor-grok-4.6", serverModelName: "cursor-grok-4.6" },
        { name: "cursor-grok-4.6-xhigh", serverModelName: "cursor-grok-4.6-xhigh" },
      ],
      [
        { modelId: "cursor-grok-4.6-low", displayName: "Grok 4.6 Low" },
        { modelId: "cursor-grok-4.6-xhigh", displayName: "Grok 4.6 Extra High" },
        { modelId: "claude-fable-5.1", displayName: "Claude Fable 5.1" },
        { modelId: "cursor-grok-4.7-low", displayName: "Grok 4.7 Low" },
        { modelId: "cursor-grok-4.7-high", displayName: "Grok 4.7 High" },
        { modelId: "cursor-composer-9", displayName: "Cursor Composer 9" },
      ],
    );

    expect(models.map((model) => model.id).sort()).toEqual([
      "claude-fable-5.1",
      "cursor-composer-9",
      "grok-4.6",
      "grok-4.7",
    ]);
    const grok = models.find((model) => model.id === "grok-4.6");
    expect(grok?.variants.xhigh).toMatchObject({
      publicId: "cursor-grok-4.6-xhigh",
      modelId: "cursor-grok-4.6-xhigh",
      parameters: [{ id: "effort", value: "xhigh" }],
    });
    expect(
      resolveCursorModelSelection(models, "cursor-grok-4.6", "xhigh")?.publicId,
    ).toBe("cursor-grok-4.6-xhigh");
    const stale = encodeCursorModelSelection({
      publicId: "grok-4.6",
      modelId: "grok-4.6",
      displayName: "Grok 4.6",
      parameters: [{ id: "effort", value: "xhigh" }],
      maxMode: false,
    });
    expect(
      selectionForCursorRequest(models, "grok-4.6", stale).publicId,
    ).toBe("cursor-grok-4.6-xhigh");
    expect(models.find((model) => model.id === "grok-4.7")?.variants.high?.publicId)
      .toBe("cursor-grok-4.7-high");
  });

  test("uses the models.dev Cursor row, not the lab row, for host limits", () => {
    const applied = applyCatalogMetadata(
      { id: "grok-4.6", contextWindow: 200_000, maxTokens: 64_000 },
      [
        {
          providerID: "xai",
          id: "grok-4.6",
          family: "grok",
          context: 500_000,
          output: 500_000,
          input: ["text", "image"],
          released: 1,
        },
        {
          providerID: "cursor",
          id: "grok-4.6",
          context: 256_000,
          output: 32_000,
          input: ["text"],
          released: 2,
          cost: [{ input: 2, output: 6, cache: { read: 0.5, write: 0 } }],
        },
      ],
      { context: 200_000, output: 64_000 },
    );
    expect(applied).toMatchObject({
      family: "grok",
      context: 256_000,
      output: 32_000,
      input: ["text"],
      released: 2,
      cost: [{ input: 2, output: 6, cache: { read: 0.5, write: 0 } }],
    });
  });

  test("groups usable-model effort variants with configured fallback limits", () => {
    const models = normalizeCursorModels([
      {
        modelId: "claude-opus-low",
        displayName: "Claude Opus Low",
        thinkingDetails: {},
      },
      {
        modelId: "claude-opus-high",
        displayName: "Claude Opus High",
        thinkingDetails: {},
      },
    ]);

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "claude-opus",
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
      variants: {
        low: expect.any(Object),
        high: expect.any(Object),
      },
    });
  });
});
