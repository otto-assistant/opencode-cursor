import type { CursorModel } from "../models.js";
import {
  CURSOR_PROVIDER_ID,
  CURSOR_VARIANT_OPTION,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL_ID,
  GENERATED_VARIANT_KEYS,
  OPENAI_COMPATIBLE_NPM,
} from "../shared/constants.js";
import { estimateModelCost } from "./pricing.js";

function selectDefaultCursorModel(
  models: CursorModel[],
): CursorModel | undefined {
  return (
    models.find((model) => model.id === "composer-2") ??
    models.find((model) => model.id === "composer-2-fast") ??
    models.find((model) => model.id === "composer-1.5") ??
    models.find((model) => model.id.startsWith("composer-")) ??
    models[0]
  );
}

function buildRuntimeVariants(
  model: CursorModel,
): Record<string, Record<string, string>> {
  return Object.fromEntries(
    Object.keys(model.variants).map((key) => [
      key,
      { [CURSOR_VARIANT_OPTION]: key },
    ]),
  );
}

function buildConfigVariants(
  model: CursorModel,
): Record<string, Record<string, string | boolean>> {
  const variants: Record<string, Record<string, string | boolean>> =
    buildRuntimeVariants(model);
  for (const key of GENERATED_VARIANT_KEYS) {
    if (!(key in variants)) variants[key] = { disabled: true };
  }
  return variants;
}

function buildProviderModel(
  model: CursorModel,
  id: string,
  port: number,
): Record<string, any> {
  const contextWindow =
    model.contextWindow > 0 ? model.contextWindow : DEFAULT_CONTEXT_WINDOW;
  const maxTokens = model.maxTokens > 0 ? model.maxTokens : DEFAULT_MAX_TOKENS;
  return {
    id,
    providerID: CURSOR_PROVIDER_ID,
    api: {
      // Send the catalog/alias id literally. For the "default" alias this means
      // Cursor receives "default" and performs its own server-side model
      // auto-selection and rate-limit routing. Pre-resolving it to a concrete
      // model here would defeat that (see proxy.resolveProxyModelId).
      id,
      url: `http://localhost:${port}/v1`,
      npm: OPENAI_COMPATIBLE_NPM,
    },
    name: id === DEFAULT_MODEL_ID ? `Default (${model.name})` : model.name,
    // Cursor agent models accept image attachments (vision). OpenCode gates
    // file/image parts client-side on these flags — leaving image:false made
    // every Cursor model report "does not support Image input".
    capabilities: {
      temperature: true,
      reasoning:
        id === DEFAULT_MODEL_ID
          ? false
          : model.reasoning && Object.keys(model.variants).length > 0,
      attachment: true,
      toolcall: true,
      input: {
        text: true,
        audio: false,
        image: true,
        video: false,
        pdf: false,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: false,
    },
    modalities: {
      input: ["text", "image"],
      output: ["text"],
    },
    cost: estimateModelCost(model.id),
    limit: {
      context: contextWindow,
      output: maxTokens,
    },
    status: "active" as const,
    options: {
      includeUsage: true,
    },
    headers: {},
    release_date: "",
    variants: id === DEFAULT_MODEL_ID ? {} : buildRuntimeVariants(model),
  };
}

export function buildCursorProviderModels(
  models: CursorModel[],
  port: number,
): Record<string, any> {
  const providerModels = Object.fromEntries(
    models.map((model) => [model.id, buildProviderModel(model, model.id, port)]),
  );
  const defaultModel = selectDefaultCursorModel(models);
  if (defaultModel && !(DEFAULT_MODEL_ID in providerModels)) {
    providerModels[DEFAULT_MODEL_ID] = buildProviderModel(
      defaultModel,
      DEFAULT_MODEL_ID,
      port,
    );
  }
  return providerModels;
}

export function buildConfigModelEntries(
  models: CursorModel[],
): Record<string, Record<string, any>> {
  const entries: Record<string, Record<string, any>> = {};
  for (const model of models) {
    const contextWindow =
      model.contextWindow > 0 ? model.contextWindow : DEFAULT_CONTEXT_WINDOW;
    const maxTokens =
      model.maxTokens > 0 ? model.maxTokens : DEFAULT_MAX_TOKENS;
    entries[model.id] = {
      name: model.name,
      // OpenCode prepends generic low/medium/high variants for reasoning-capable
      // OpenAI-compatible models before merging custom variants. Marking this
      // config descriptor non-reasoning keeps our explicit Cursor variant map
      // authoritative, including its canonical presentation order. Cursor
      // reasoning output and routing are handled by the local proxy.
      reasoning: false,
      tool_call: true,
      // Required for OpenCode's static config path: without modalities.input
      // including "image", attachments are stripped before they reach the proxy.
      modalities: {
        input: ["text", "image"],
        output: ["text"],
      },
      capabilities: {
        tools: true,
        input: ["text", "image"],
        output: ["text"],
      },
      cost: estimateModelCost(model.id),
      limit: {
        context: contextWindow,
        output: maxTokens,
      },
      options: {
        includeUsage: true,
      },
      variants: buildConfigVariants(model),
    };
  }

  // Seed a "default" entry so OpenCode versions that build the model menu from
  // static config still expose Cursor's auto-routing. The entry key ("default")
  // is sent upstream verbatim, so Cursor selects/routes the model itself.
  const defaultModel = selectDefaultCursorModel(models);
  if (defaultModel && !(DEFAULT_MODEL_ID in entries)) {
    const contextWindow =
      defaultModel.contextWindow > 0
        ? defaultModel.contextWindow
        : DEFAULT_CONTEXT_WINDOW;
    const maxTokens =
      defaultModel.maxTokens > 0
        ? defaultModel.maxTokens
        : DEFAULT_MAX_TOKENS;
    entries[DEFAULT_MODEL_ID] = {
      name: `Default (${defaultModel.name})`,
      reasoning: false,
      tool_call: true,
      modalities: {
        input: ["text", "image"],
        output: ["text"],
      },
      capabilities: {
        tools: true,
        input: ["text", "image"],
        output: ["text"],
      },
      cost: estimateModelCost(defaultModel.id),
      limit: {
        context: contextWindow,
        output: maxTokens,
      },
      options: {
        includeUsage: true,
      },
      variants: Object.fromEntries(
        GENERATED_VARIANT_KEYS.map((key) => [key, { disabled: true }]),
      ),
    };
  }
  return entries;
}
