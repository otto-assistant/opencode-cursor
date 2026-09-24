import { test } from "bun:test";
import * as modules from "../src/models";
import { assert, assertEqual, assertArrayEqual } from "./helpers/assert";
type TestModules = typeof modules;

function enumParameter(
  id: string,
  values: Array<{ value: string; displayName?: string }>,
): Record<string, unknown> {
  return {
    id,
    parameterType: { enumParameter: { values } },
  };
}

function booleanParameter(id: string): Record<string, unknown> {
  return {
    id,
    parameterType: {
      booleanParameter: {
        values: [{ value: "false" }, { value: "true", displayName: "Fast" }],
      },
    },
  };
}

function makeGptAvailableModel(includeFast = false): Record<string, unknown> {
  // Cursor does not guarantee the presentation order OpenCode expects.
  const efforts = ["low", "medium", "high", "none", "xhigh", "max"];
  const baseVariants = ["272k", "1m"].flatMap((context) =>
    efforts.map((reasoning) => ({
      parameterValues: [
        { id: "context", value: context },
        { id: "reasoning", value: reasoning },
        { id: "fast", value: "false" },
      ],
      legacySlug: `gpt-5.6-sol-${reasoning}`,
      isMaxMode: context === "1m",
      isDefaultNonMaxConfig: context === "272k" && reasoning === "medium",
      isDefaultMaxConfig: context === "1m" && reasoning === "medium",
    })),
  );
  const variants = includeFast
    ? baseVariants.flatMap((variant) => [
        variant,
        {
          ...variant,
          parameterValues: variant.parameterValues.map((parameter) =>
            parameter.id === "fast" ? { id: "fast", value: "true" } : parameter,
          ),
          legacySlug: `${variant.legacySlug}-fast`,
          isDefaultNonMaxConfig: false,
          isDefaultMaxConfig: false,
        },
      ])
    : baseVariants;
  return {
    name: "gpt-5.6-sol",
    clientDisplayName: "GPT-5.6 Sol",
    serverModelName: "gpt-5.6-sol",
    parameterDefinitions: [
      enumParameter("context", [
        { value: "272k", displayName: "272K" },
        { value: "1m", displayName: "1M" },
      ]),
      enumParameter(
        "reasoning",
        efforts.map((value) => ({ value })),
      ),
      booleanParameter("fast"),
    ],
    variants,
  };
}

function makeOpusAvailableModel(): Record<string, unknown> {
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  const variants = ["300k", "1m"].flatMap((context) =>
    [false, true].flatMap((thinking) =>
      efforts.map((effort) => ({
        parameterValues: [
          { id: "thinking", value: String(thinking) },
          { id: "context", value: context },
          { id: "effort", value: effort },
          { id: "fast", value: "false" },
        ],
        legacySlug: `claude-opus-4-8-${thinking ? "thinking-" : ""}${effort}`,
        isMaxMode: context === "1m",
        isDefaultNonMaxConfig:
          context === "300k" && thinking && effort === "high",
        isDefaultMaxConfig: context === "1m" && thinking && effort === "high",
      })),
    ),
  );
  return {
    name: "claude-opus-4-8",
    clientDisplayName: "Opus 4.8",
    serverModelName: "claude-opus-4-8",
    parameterDefinitions: [
      booleanParameter("thinking"),
      enumParameter("context", [
        { value: "300k", displayName: "300K" },
        { value: "1m", displayName: "1M" },
      ]),
      enumParameter(
        "effort",
        efforts.map((value) => ({ value })),
      ),
      booleanParameter("fast"),
    ],
    variants,
  };
}

function filterAvailableVariants(
  model: Record<string, unknown>,
  predicate: (parameters: Record<string, string>) => boolean,
): Record<string, unknown> {
  const variants = Array.isArray(model.variants) ? model.variants : [];
  return {
    ...model,
    variants: variants.filter((variant) => {
      if (!variant || typeof variant !== "object" || Array.isArray(variant))
        return false;
      const variantRecord = variant as Record<string, unknown>;
      const parameterValues = Array.isArray(variantRecord.parameterValues)
        ? variantRecord.parameterValues
        : [];
      const values = Object.fromEntries(
        parameterValues.flatMap((parameter) => {
          if (
            !parameter ||
            typeof parameter !== "object" ||
            Array.isArray(parameter)
          ) {
            return [];
          }
          const parameterRecord = parameter as Record<string, unknown>;
          return typeof parameterRecord.id === "string"
            ? [[parameterRecord.id, String(parameterRecord.value)] as const]
            : [];
        }),
      );
      return predicate(values);
    }),
  };
}

async function testAvailableModelParameterGrouping(modules: TestModules) {
  console.log("[test] Testing parameter-aware AvailableModels grouping...");
  const models = modules.normalizeAvailableModels([
    makeGptAvailableModel(),
    makeOpusAvailableModel(),
  ]);

  const gptIds = models
    .filter((model) => model.id.startsWith("gpt-5.6-sol"))
    .map((model) => model.id);
  assertArrayEqual(
    gptIds,
    ["gpt-5.6-sol", "gpt-5.6-sol-1m"],
    "Expected only returned GPT context combinations",
  );
  for (const id of gptIds) {
    const model = models.find((candidate) => candidate.id === id)!;
    assertArrayEqual(
      Object.keys(model.variants),
      ["none", "low", "medium", "high", "xhigh", "max"],
      `Expected simple GPT effort variants on ${id}`,
    );
  }

  const gpt1mHigh = models.find((model) => model.id === "gpt-5.6-sol-1m")!
    .variants.high;
  assertEqual(
    gpt1mHigh.modelId,
    "gpt-5.6-sol",
    "Expected shared GPT server model",
  );
  assertEqual(gpt1mHigh.maxMode, true, "Expected 1M GPT max mode");
  assertEqual(
    Object.fromEntries(
      gpt1mHigh.parameters.map((parameter) => [parameter.id, parameter.value]),
    ).context,
    "1m",
    "Expected 1M GPT context parameter",
  );
  const fastModels = modules.normalizeAvailableModels([
    makeGptAvailableModel(true),
  ]);
  assertArrayEqual(
    fastModels.map((model) => model.id),
    [
      "gpt-5.6-sol",
      "gpt-5.6-sol-1m",
      "gpt-5.6-sol-1m-fast",
      "gpt-5.6-sol-fast",
    ],
    "Expected Fast listings only when fast=true variants are returned",
  );
  const gptFast = fastModels.find((model) => model.id === "gpt-5.6-sol-fast")!;
  assertEqual(
    Object.fromEntries(
      gptFast.variants.medium.parameters.map((parameter) => [
        parameter.id,
        parameter.value,
      ]),
    ).fast,
    "true",
    "Expected returned GPT Fast listing",
  );

  const fastWithout1m = modules.normalizeAvailableModels([
    filterAvailableVariants(
      makeGptAvailableModel(true),
      (parameters) => parameters.context === "272k",
    ),
  ]);
  assertArrayEqual(
    fastWithout1m.map((model) => model.id),
    ["gpt-5.6-sol", "gpt-5.6-sol-fast"],
    "Expected an org with Fast but no 1M to expose only those combinations",
  );
  const oneMWithoutFast = modules.normalizeAvailableModels([
    filterAvailableVariants(
      makeGptAvailableModel(false),
      (parameters) => parameters.context === "1m",
    ),
  ]);
  assertArrayEqual(
    oneMWithoutFast.map((model) => model.id),
    ["gpt-5.6-sol-1m"],
    "Expected an org with 1M but no Fast to expose only the 1M listing",
  );

  const opusIds = models
    .filter((model) => model.id.startsWith("claude-opus-4-8"))
    .map((model) => model.id);
  assertArrayEqual(
    opusIds,
    ["claude-opus-4-8", "claude-opus-4-8-1m"],
    "Expected Thinking to stay on the context family, not a separate model",
  );
  for (const id of opusIds) {
    const model = models.find((candidate) => candidate.id === id)!;
    assertArrayEqual(
      Object.keys(model.variants),
      ["none", "low", "medium", "high", "xhigh", "max"],
      `Expected non-thinking none plus thinking effort variants on ${id}`,
    );
    assertEqual(
      model.variants.none?.parameters.find((parameter) => parameter.id === "thinking")
        ?.value,
      "false",
      `Expected none to be non-thinking on ${id}`,
    );
    assertEqual(
      model.variants.high?.parameters.find((parameter) => parameter.id === "thinking")
        ?.value,
      "true",
      `Expected effort variants to keep thinking on ${id}`,
    );
  }
  assertEqual(
    models.find((model) => model.id === "claude-opus-4-8-1m")?.name,
    "Opus 4.8 1M",
    "Expected context to remain in the listing name",
  );
  const thinkingOnly = modules.normalizeAvailableModels([
    filterAvailableVariants(
      makeOpusAvailableModel(),
      (parameters) =>
        parameters.context === "300k" && parameters.thinking === "true",
    ),
  ]);
  assertArrayEqual(
    thinkingOnly.map((model) => model.id),
    ["claude-opus-4-8"],
    "Expected restricted Thinking availability to stay on the base model",
  );

  const edgeModels = modules.normalizeAvailableModels([
    {
      name: "partial",
      clientDisplayName: "Partial",
      serverModelName: "partial",
      parameterDefinitions: [
        enumParameter("effort", [
          { value: "low" },
          { value: "medium" },
          { value: "high" },
          { value: "turbo" },
        ]),
        booleanParameter("fast"),
      ],
      variants: [
        {
          parameterValues: [
            { id: "effort", value: "low" },
            { id: "fast", value: "false" },
          ],
          legacySlug: "partial-low",
        },
        {
          parameterValues: [
            { id: "effort", value: "low" },
            { id: "fast", value: "true" },
          ],
          legacySlug: "partial-low-fast",
        },
        {
          parameterValues: [{ id: "effort", value: "medium" }],
          legacySlug: "partial-medium",
        },
        {
          parameterValues: [
            { id: "effort", value: "HIGH" },
            { id: "fast", value: "false" },
          ],
          legacySlug: "partial-high",
        },
        {
          parameterValues: [
            { id: "effort", value: "turbo" },
            { id: "fast", value: "false" },
          ],
          legacySlug: "partial-turbo",
        },
      ],
    },
    {
      name: "collision",
      clientDisplayName: "Collision",
      serverModelName: "collision",
      parameterDefinitions: [
        enumParameter("effort", [{ value: "low" }, { value: "medium" }]),
        booleanParameter("fast"),
      ],
      variants: [
        {
          parameterValues: [
            { id: "effort", value: "low" },
            { id: "fast", value: "false" },
          ],
          legacySlug: "collision-low",
        },
        {
          parameterValues: [
            { id: "effort", value: "medium" },
            { id: "fast", value: "false" },
          ],
          legacySlug: "collision-medium",
        },
        {
          parameterValues: [
            { id: "effort", value: "low" },
            { id: "fast", value: "true" },
          ],
          legacySlug: "collision-low-fast",
        },
        {
          parameterValues: [
            { id: "effort", value: "medium" },
            { id: "fast", value: "true" },
          ],
          legacySlug: "collision-medium-fast",
        },
      ],
    },
    {
      name: "collision-fast",
      clientDisplayName: "Native Collision Fast",
      serverModelName: "collision-fast",
      variants: [{ legacySlug: "collision-fast" }],
    },
    {
      name: "dimensions",
      clientDisplayName: "Dimensions",
      serverModelName: "dimensions",
      parameterDefinitions: [
        enumParameter("region", [
          { value: "us", displayName: "US" },
          { value: "eu", displayName: "EU" },
        ]),
        enumParameter("effort", [{ value: "low" }, { value: "high" }]),
      ],
      variants: [
        {
          parameterValues: [
            { id: "region", value: "us" },
            { id: "effort", value: "low" },
          ],
          legacySlug: "dimensions-us-low",
        },
        {
          parameterValues: [
            { id: "region", value: "us" },
            { id: "effort", value: "high" },
          ],
          legacySlug: "dimensions-us-high",
        },
        {
          parameterValues: [
            { id: "region", value: "eu" },
            { id: "effort", value: "low" },
          ],
          legacySlug: "dimensions-eu-low",
        },
        {
          parameterValues: [
            { id: "region", value: "eu" },
            { id: "effort", value: "high" },
          ],
          legacySlug: "dimensions-eu-high",
        },
      ],
    },
    {
      name: "unknown-dimension",
      clientDisplayName: "Unknown Dimension",
      serverModelName: "unknown-dimension",
      variants: [
        {
          parameterValues: [
            { id: "region", value: "us" },
            { id: "effort", value: "low" },
          ],
          legacySlug: "unknown-dimension-low",
        },
        {
          parameterValues: [{ id: "effort", value: "high" }],
          legacySlug: "unknown-dimension-high",
        },
      ],
    },
    {
      name: "collision-values",
      clientDisplayName: "Collision Values",
      serverModelName: "collision-values",
      parameterDefinitions: [
        enumParameter("region", [
          { value: "us" },
          { value: "eu-west" },
          { value: "eu west" },
        ]),
        enumParameter("effort", [{ value: "low" }, { value: "high" }]),
      ],
      variants: [
        {
          parameterValues: [
            { id: "region", value: "eu-west" },
            { id: "effort", value: "low" },
          ],
          legacySlug: "collision-values-low",
        },
        {
          parameterValues: [
            { id: "region", value: "eu west" },
            { id: "effort", value: "high" },
          ],
          legacySlug: "collision-values-high",
        },
      ],
    },
    {
      name: "sonnet-4-6-test",
      clientDisplayName: "Sonnet 4.6 Test",
      serverModelName: "sonnet-4-6-test",
      variants: ["low", "medium", "high", "max"].map((effort) => ({
        parameterValues: [{ id: "effort", value: effort }],
        legacySlug: `sonnet-4-6-test-${effort}`,
      })),
    },
    {
      name: "sonnet-5-test",
      clientDisplayName: "Sonnet 5 Test",
      serverModelName: "sonnet-5-test",
      variants: ["low", "medium", "high", "xhigh", "max"].map((effort) => ({
        parameterValues: [{ id: "effort", value: effort }],
        legacySlug: `sonnet-5-test-${effort}`,
      })),
    },
  ]);
  assertArrayEqual(
    Object.keys(
      edgeModels.find((model) => model.id === "partial-fast")!.variants,
    ),
    ["low"],
    "Expected only explicitly returned Fast effort combinations",
  );
  assertArrayEqual(
    Object.keys(edgeModels.find((model) => model.id === "partial")!.variants),
    ["low", "medium", "high"],
    "Expected unknown efforts to be excluded and mixed-case efforts normalized",
  );
  const collision = edgeModels.find((model) => model.id === "collision-fast");
  assertEqual(
    collision?.defaultSelection.modelId,
    "collision-fast",
    "Expected a declared model to win over a generated structural id collision",
  );
  assertEqual(
    edgeModels.find((model) => model.id === "collision-fast-from-collision")
      ?.defaultSelection.modelId,
    "collision",
    "Expected the colliding returned structural combination to remain addressable",
  );
  assertArrayEqual(
    edgeModels
      .filter((model) => model.id.startsWith("dimensions"))
      .map((model) => model.id),
    ["dimensions", "dimensions-region-eu"],
    "Expected arbitrary returned structural parameter combinations to form listings",
  );
  assertArrayEqual(
    edgeModels
      .filter((model) => model.id.startsWith("unknown-dimension"))
      .map((model) => model.id),
    ["unknown-dimension", "unknown-dimension-region-unset"],
    "Expected missing and explicit unknown structural values to remain distinct",
  );
  const normalizedCollisionIds = edgeModels
    .filter((model) => model.id.startsWith("collision-values-region-eu-west"))
    .map((model) => model.id);
  assertArrayEqual(
    normalizedCollisionIds,
    [
      "collision-values-region-eu-west",
      "collision-values-region-eu-west-from-collision-values",
    ],
    "Expected lossless structural grouping before public-id normalization",
  );
  assertArrayEqual(
    normalizedCollisionIds.map(
      (id) =>
        edgeModels
          .find((model) => model.id === id)!
          .defaultSelection.parameters.find(
            (parameter) => parameter.id === "region",
          )!.value,
    ),
    ["eu-west", "eu west"],
    "Expected both colliding structural values to remain addressable",
  );
  assertArrayEqual(
    Object.keys(
      edgeModels.find((model) => model.id === "sonnet-4-6-test")!.variants,
    ),
    ["low", "medium", "high", "max"],
    "Expected Sonnet 4.6 to omit unavailable xhigh",
  );
  assertArrayEqual(
    Object.keys(
      edgeModels.find((model) => model.id === "sonnet-5-test")!.variants,
    ),
    ["low", "medium", "high", "xhigh", "max"],
    "Expected Sonnet 5 to retain returned xhigh",
  );

  const namedModels = modules.normalizeAvailableModels([
    {
      name: "grok-4-5",
      serverModelName: "grok-4-5",
      supportsThinking: true,
      supportsMaxMode: true,
      supportsNonMaxMode: true,
      isUserAdded: true,
      inputboxShortModelName: "grok-4-5",
    },
    {
      name: "grok-code-fast-1",
      serverModelName: "grok-code-fast-1",
      supportsThinking: true,
      tooltipData: {
        markdownContent:
          "**Grok Code Fast 1**<br />Fast, good for daily use.<br /><br />256k context window",
      },
      isUserAdded: true,
    },
  ]);
  assertArrayEqual(
    namedModels.map((model) => model.id).sort(),
    ["grok-4-5", "grok-code-fast-1"],
    "Expected named models without variants to be preserved",
  );
  assertEqual(
    namedModels.find((model) => model.id === "grok-4-5")?.name,
    "Grok 4.5",
    "Expected Grok 4.5 display name formatting",
  );
  assertEqual(
    namedModels.find((model) => model.id === "grok-code-fast-1")?.name,
    "Grok Code Fast 1",
    "Expected tooltip title for named Grok models",
  );

  console.log("[test] Parameter-aware AvailableModels grouping OK");
}

async function testCursorModelVariantGrouping(modules: TestModules) {
  console.log("[test] Testing Cursor model family grouping...");

  const models = modules.normalizeCursorModels([
    {
      modelId: "gpt-5.6-sol-low",
      displayName: "GPT-5.6 Sol Low",
      thinkingDetails: {},
    },
    {
      modelId: "gpt-5.6-sol-medium",
      displayName: "GPT-5.6 Sol Medium",
      thinkingDetails: {},
    },
    {
      modelId: "gpt-5.6-sol-high",
      displayName: "GPT-5.6 Sol High",
      thinkingDetails: {},
    },
    {
      modelId: "gpt-5.6-sol-extra-high",
      displayName: "GPT-5.6 Sol Extra High",
      thinkingDetails: {},
    },
    {
      modelId: "claude-opus-4.8-none",
      displayName: "Claude Opus 4.8 None",
      thinkingDetails: {},
    },
    {
      modelId: "claude-opus-4.8-high",
      displayName: "Claude Opus 4.8 High",
      thinkingDetails: {},
    },
    {
      modelId: "claude-opus-4.8-low-thinking",
      displayName: "Claude Opus 4.8 Low Thinking",
      thinkingDetails: {},
    },
    {
      modelId: "claude-opus-4.8-high-thinking",
      displayName: "Claude Opus 4.8 High Thinking",
      thinkingDetails: {},
    },
    {
      modelId: "claude-opus-4.8-1m-none",
      displayName: "Claude Opus 4.8 1M None",
      thinkingDetails: {},
    },
    {
      modelId: "claude-opus-4.8-1m-high",
      displayName: "Claude Opus 4.8 1M High",
      thinkingDetails: {},
    },
    {
      modelId: "claude-opus-4.8-1m-low-thinking",
      displayName: "Claude Opus 4.8 1M Low Thinking",
      thinkingDetails: {},
    },
    {
      modelId: "claude-opus-4.8-1m-high-thinking",
      displayName: "Claude Opus 4.8 1M High Thinking",
      thinkingDetails: {},
    },
    {
      modelId: "gpt-5.1-codex-max",
      displayName: "GPT-5.1 Codex Max",
      thinkingDetails: {},
    },
  ]);

  assertArrayEqual(
    models.map((model) => model.id),
    [
      "claude-opus-4.8",
      "claude-opus-4.8-1m",
      "gpt-5.1-codex-max",
      "gpt-5.6-sol",
    ],
    "Expected thinking SKUs to become reasoning variants on the non-thinking family",
  );

  const gpt = models.find((model) => model.id === "gpt-5.6-sol");
  assert(gpt, "Expected grouped GPT family");
  assertEqual(
    gpt.name,
    "GPT-5.6 Sol",
    "Expected variant label removed from family name",
  );
  assertEqual(
    gpt.defaultSelection.publicId,
    "gpt-5.6-sol-low",
    "Expected the lowest available effort when Cursor provides no default or none",
  );
  assertEqual(
    gpt.variants.low.publicId,
    "gpt-5.6-sol-low",
    "Expected low wire model",
  );
  assertEqual(
    gpt.variants.medium.publicId,
    "gpt-5.6-sol-medium",
    "Expected medium wire model",
  );
  assertEqual(
    gpt.variants.high.publicId,
    "gpt-5.6-sol-high",
    "Expected high wire model",
  );
  assertEqual(
    gpt.variants.xhigh.publicId,
    "gpt-5.6-sol-extra-high",
    "Expected Extra High to use OpenCode's xhigh variant key",
  );
  assertEqual(
    modules.resolveCursorModelSelection(models, "gpt-5.6-sol", "high")
      ?.publicId,
    "gpt-5.6-sol-high",
    "Expected explicit variant to resolve to its Cursor wire model",
  );
  assertEqual(
    modules.resolveCursorModelSelection(models, "gpt-5.6-sol", undefined)
      ?.publicId,
    "gpt-5.6-sol-low",
    "Expected missing variant to resolve to the family default",
  );

  const opus = models.find((model) => model.id === "claude-opus-4.8-1m");
  assert(opus, "Expected grouped 1M family");
  assertEqual(
    opus.variants.none.publicId,
    "claude-opus-4.8-1m-none",
    "Expected non-thinking to become the none variant",
  );
  assertEqual(
    opus.variants.high.publicId,
    "claude-opus-4.8-1m-high-thinking",
    "Expected thinking effort to become the high variant",
  );
  assertEqual(
    opus.name,
    "Claude Opus 4.8 1M",
    "Expected Thinking not to remain a separate model name",
  );

  const codexMax = models.find((model) => model.id === "gpt-5.1-codex-max");
  assert(codexMax, "Expected ambiguous lone -max model to remain flat");
  assertEqual(
    Object.keys(codexMax.variants).length,
    0,
    "Expected no inferred variants for an ambiguous lone model",
  );

  const sameNameHigh = modules.normalizeCursorModels([
    {
      modelId: "gemini-3.7-flash-medium",
      displayName: "Gemini 3.7 Flash",
    },
    {
      modelId: "gemini-3.7-flash-low",
      displayName: "Gemini 3.7 Flash",
    },
    {
      modelId: "gemini-3.7-flash-high",
      displayName: "Gemini 3.7 Flash",
    },
  ]);
  assertEqual(
    sameNameHigh.length,
    1,
    "Expected ID-based effort grouping even when display names omit High",
  );
  assertEqual(sameNameHigh[0]?.id, "gemini-3.7-flash", "Expected Flash family id");
  assertEqual(
    sameNameHigh[0]?.variants.high?.publicId,
    "gemini-3.7-flash-high",
    "Expected High to remain an exact Cursor model ID",
  );

  console.log("[test] Cursor model family grouping OK");
}

test("account-discovered parameter combinations remain exact and collision-safe", () =>
  testAvailableModelParameterGrouping(modules));
test("usable model families preserve thinking, context, and wire variants", () =>
  testCursorModelVariantGrouping(modules));
