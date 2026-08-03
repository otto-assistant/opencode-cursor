/**
 * Cursor model discovery via AvailableModels, with GetUsableModels and a
 * bundled catalog as fallbacks.
 */
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { tool } from "@opencode-ai/plugin";
const z = tool.schema;
import { callCursorUnaryRpc, probeCursorAgentSelection } from "./proxy.js";
import {
  literalCursorModelSelection,
  type CursorModelParameter,
  type CursorModelSelection,
} from "./model-selection.js";
import {
  GetUsableModelsRequestSchema,
  GetUsableModelsResponseSchema,
} from "./proto/agent_pb.js";

const GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";
const AVAILABLE_MODELS_PATH = "/aiserver.v1.AiService/AvailableModels";

// Cursor's AvailableModels omits some catalog entries unless they are named
// explicitly. Grok models (including Grok 4.5 / grok-4-5) are user-added
// named models and never appear with an empty additionalModelNames list.
const ADDITIONAL_MODEL_NAMES = [
  "grok-4-5",
  "grok-4.20",
  "grok-code-fast-1",
  "grok-4-fast-reasoning",
  "grok-4-0709",
] as const;

const AGENT_PROBE_MODEL_IDS = new Set<string>(ADDITIONAL_MODEL_NAMES);

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;

const CursorModelDetailsSchema = z.object({
  modelId: z.string(),
  displayName: z.string().optional().catch(undefined),
  displayNameShort: z.string().optional().catch(undefined),
  displayModelId: z.string().optional().catch(undefined),
  aliases: z
    .array(z.unknown())
    .optional()
    .catch([])
    .transform((aliases) =>
      (aliases ?? []).filter(
        (alias: unknown): alias is string => typeof alias === "string",
      ),
    ),
  thinkingDetails: z.unknown().optional(),
});

interface CursorModelDetails {
  modelId: string;
  displayName?: string;
  displayNameShort?: string;
  displayModelId?: string;
  aliases: string[];
  thinkingDetails?: unknown;
}

export interface CursorModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  defaultSelection: CursorModelSelection;
  variants: Record<string, CursorModelSelection>;
}

export const FALLBACK_MODELS: CursorModel[] = [
  // Composer models
  flatModel("composer-1", "Composer 1", true, 200_000, 64_000),
  flatModel("composer-1.5", "Composer 1.5", true, 200_000, 64_000),
  // Claude models
  flatModel("claude-4.6-opus-high", "Claude 4.6 Opus", true, 200_000, 128_000),
  flatModel("claude-4.6-sonnet-medium", "Claude 4.6 Sonnet", true, 200_000, 64_000),
  flatModel("claude-4.5-sonnet", "Claude 4.5 Sonnet", true, 200_000, 64_000),
  // GPT models
  flatModel("gpt-5.4-medium", "GPT-5.4", true, 272_000, 128_000),
  flatModel("gpt-5.2", "GPT-5.2", true, 400_000, 128_000),
  flatModel("gpt-5.2-codex", "GPT-5.2 Codex", true, 400_000, 128_000),
  flatModel("gpt-5.3-codex", "GPT-5.3 Codex", true, 400_000, 128_000),
  flatModel("gpt-5.3-codex-spark-preview", "GPT-5.3 Codex Spark", true, 128_000, 128_000),
  // Other models
  flatModel("gemini-3.1-pro", "Gemini 3.1 Pro", true, 1_000_000, 64_000),
  flatModel("grok-code-fast-1", "Grok Code Fast 1", false, 256_000, 64_000),
  flatModel("grok-4-fast-reasoning", "Grok 4 Fast Reasoning", true, 200_000, 64_000),
];

/**
 * Minimal catalog seeded while logged out. OpenCode removes providers that
 * have zero models from `provider.list()`, which hides Cursor in OpenChamber's
 * provider settings and blocks the OAuth connect button. A single placeholder
 * keeps the provider visible without advertising a fake model catalog.
 */
export const LOGIN_PLACEHOLDER_MODELS: CursorModel[] = [
  flatModel(
    "default",
    "Sign in: Reconnect → paste Cursor API key (crsr_…)",
    false,
    200_000,
    64_000,
  ),
];

interface VariantDescriptor {
  key: string;
  idSuffixes: readonly string[];
  nameSuffixes: readonly string[];
}

const VARIANT_DESCRIPTORS: readonly VariantDescriptor[] = [
  variantDescriptor("none", ["none"], ["None"]),
  variantDescriptor("low", ["low"], ["Low"]),
  variantDescriptor("medium", ["medium"], ["Medium"]),
  variantDescriptor(
    "xhigh",
    ["xhigh", "extra-high"],
    ["Extra High", "XHigh", "X High"],
  ),
  variantDescriptor("high", ["high"], ["High"]),
  variantDescriptor("max", ["max"], ["Max"]),
];

const DEFAULT_VARIANT_ORDER = [
  "medium",
  "none",
  "high",
  "low",
  "xhigh",
  "max",
] as const;

const VARIANT_DISPLAY_ORDER = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

function variantDescriptor(
  key: string,
  idSuffixes: readonly string[],
  nameSuffixes: readonly string[],
): VariantDescriptor {
  return {
    key,
    idSuffixes: idSuffixes.map((suffix) => `-${suffix}`),
    nameSuffixes: nameSuffixes.map((suffix) => ` ${suffix}`),
  };
}

function flatModel(
  id: string,
  name: string,
  reasoning: boolean,
  contextWindow: number,
  maxTokens: number,
): CursorModel {
  return {
    id,
    name,
    reasoning,
    contextWindow,
    maxTokens,
    defaultSelection: literalCursorModelSelection(id),
    variants: {},
  };
}

async function fetchCursorAvailableModels(
  apiKey: string,
): Promise<CursorModel[] | null> {
  try {
    const requestBody = new TextEncoder().encode(
      JSON.stringify({
        isNightly: false,
        excludeMaxNamedModels: true,
        additionalModelNames: [...ADDITIONAL_MODEL_NAMES],
        useModelParameters: true,
        useReactModelPicker: true,
      }),
    );
    const response = await callCursorUnaryRpc({
      accessToken: apiKey,
      rpcPath: AVAILABLE_MODELS_PATH,
      requestBody,
      contentType: "application/json",
      connectProtocolVersion: "1",
    });
    if (response.timedOut || response.exitCode !== 0 || response.body.length === 0) {
      return null;
    }

    const decoded = JSON.parse(new TextDecoder().decode(response.body)) as unknown;
    const record = asRecord(decoded);
    const models = Array.isArray(record?.models)
      ? await filterAgentRunnableModels(
          apiKey,
          normalizeAvailableModels(record.models),
        )
      : [];
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

async function fetchCursorUsableModels(
  apiKey: string,
): Promise<CursorModel[] | null> {
  try {
    const requestPayload = create(GetUsableModelsRequestSchema, {});
    const requestBody = toBinary(GetUsableModelsRequestSchema, requestPayload);

    const response = await callCursorUnaryRpc({
      accessToken: apiKey,
      rpcPath: GET_USABLE_MODELS_PATH,
      requestBody,
    });

    if (response.timedOut || response.exitCode !== 0 || response.body.length === 0) {
      return null;
    }

    const decoded = decodeGetUsableModelsResponse(response.body);
    if (!decoded) return null;

    const models = normalizeCursorModels(decoded.models);
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

let cachedModels: CursorModel[] | null = null;

export type GetCursorModelsOptions = {
  /**
   * When false, return an empty list instead of the hardcoded FALLBACK_MODELS
   * catalog. Use this for provider/config UI seeding so OpenChamber never shows
   * the bundled ~14 models as if they were the live Cursor catalog (~50).
   */
  allowFallback?: boolean;
};

export async function getCursorModels(
  apiKey: string,
  options?: GetCursorModelsOptions,
): Promise<CursorModel[]> {
  if (cachedModels) return cachedModels;
  const discovered =
    (await fetchCursorAvailableModels(apiKey)) ??
    (await fetchCursorUsableModels(apiKey));
  // Only cache a successful discovery. Caching FALLBACK_MODELS would pin the
  // whole process to the bundled list after a single transient failure; instead
  // return the fallback for this call and let the next call retry discovery.
  if (discovered && discovered.length > 0) {
    cachedModels = discovered;
    return cachedModels;
  }
  if (options?.allowFallback === false) return [];
  return FALLBACK_MODELS;
}

async function filterAgentRunnableModels(
  accessToken: string,
  models: CursorModel[],
): Promise<CursorModel[]> {
  const probeTargets = models.filter((model) => AGENT_PROBE_MODEL_IDS.has(model.id));
  if (probeTargets.length === 0) return models;

  const probeResults = await Promise.all(
    probeTargets.map(async (model) => ({
      id: model.id,
      runnable: await probeCursorAgentSelection(accessToken, model.defaultSelection),
    })),
  );
  const runnableIds = new Set(
    probeResults.filter((result) => result.runnable).map((result) => result.id),
  );

  return models.filter(
    (model) => !AGENT_PROBE_MODEL_IDS.has(model.id) || runnableIds.has(model.id),
  );
}

/** @internal Test-only. */
export function clearModelCache(): void {
  cachedModels = null;
}

function decodeGetUsableModelsResponse(payload: Uint8Array): {
  models: readonly unknown[];
} | null {
  try {
    return fromBinary(GetUsableModelsResponseSchema, payload);
  } catch {
    const framedBody = decodeConnectUnaryBody(payload);
    if (!framedBody) return null;
    try {
      return fromBinary(GetUsableModelsResponseSchema, framedBody);
    } catch {
      return null;
    }
  }
}

function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
  if (payload.length < 5) return null;

  let offset = 0;
  while (offset + 5 <= payload.length) {
    const flags = payload[offset]!;
    const view = new DataView(
      payload.buffer,
      payload.byteOffset + offset,
      payload.byteLength - offset,
    );
    const messageLength = view.getUint32(1, false);
    const frameEnd = offset + 5 + messageLength;
    if (frameEnd > payload.length) return null;

    // Compression flag
    if ((flags & 0b0000_0001) !== 0) return null;

    // End-of-stream flag — skip trailer frames
    if ((flags & 0b0000_0010) === 0) {
      return payload.subarray(offset + 5, frameEnd);
    }

    offset = frameEnd;
  }

  return null;
}

interface AvailableSelection {
  effort?: string;
  isDefault: boolean;
  selection: CursorModelSelection;
}

interface AvailableGroup {
  id: string;
  name: string;
  contextWindow: number;
  selections: AvailableSelection[];
}

interface ParameterMetadata {
  id: string;
  baseline?: string;
  labels: Map<string, string>;
  order: number;
  declared: boolean;
}

export function normalizeAvailableModels(models: readonly unknown[]): CursorModel[] {
  const declaredNames = new Set(
    models
      .map(asRecord)
      .map((model) => stringProp(model, "name"))
      .filter((name): name is string => Boolean(name)),
  );
  const output = new Map<
    string,
    { model: CursorModel; rank: number; sourceName: string }
  >();

  for (const rawModel of models) {
    const model = asRecord(rawModel);
    const name = stringProp(model, "name");
    if (!model || !name) continue;

    const displayName = pickAvailableDisplayName(model, name);
    const serverModelName = stringProp(model, "serverModelName") ?? name;
    const definitions = arrayProp(model, "parameterDefinitions")
      .map(asRecord)
      .filter((value): value is Record<string, unknown> => Boolean(value));
    const variants = arrayProp(model, "variants")
      .map(asRecord)
      .filter((value): value is Record<string, unknown> => Boolean(value));
    const structuralParameters = buildStructuralParameterMetadata(
      definitions,
      variants,
    );

    const groups = new Map<string, AvailableGroup>();
    for (const variant of variants) {
      const parameters = parseParameterValues(variant.parameterValues);
      const values = new Map(parameters.map((parameter) => [parameter.id, parameter.value]));
      const context = values.get("context");
      const rawEffort = values.get("reasoning") ?? values.get("effort");
      const effort = normalizeEffort(rawEffort);
      if (rawEffort && !effort) continue;
      const structuralParts = buildStructuralParts(values, structuralParameters);
      const suffixes = structuralParts.map((part) => part.id);
      const groupId = [name, ...suffixes].join("-");
      const groupKey = structuralParameterSignature(
        values,
        structuralParameters,
      );
      const groupName = [
        displayName,
        ...structuralParts.map((part) => part.name),
      ]
        .filter((value): value is string => Boolean(value))
        .join(" ");
      const legacySlug = stringProp(variant, "legacySlug") ?? name;
      const selection: CursorModelSelection = {
        publicId: legacySlug,
        modelId: serverModelName,
        displayName: groupName,
        parameters,
        maxMode: variant.isMaxMode === true,
      };
      const group = groups.get(groupKey) ?? {
        id: groupId,
        name: groupName,
        contextWindow: parseTokenLimit(context) ?? DEFAULT_CONTEXT_WINDOW,
        selections: [],
      };
      group.selections.push({
        effort,
        isDefault:
          variant.isDefaultNonMaxConfig === true ||
          variant.isDefaultMaxConfig === true,
        selection,
      });
      groups.set(groupKey, group);
    }

    if (groups.size === 0) {
      const flatSelection: CursorModelSelection = {
        publicId: name,
        modelId: serverModelName,
        displayName,
        parameters: [],
        maxMode:
          model.supportsMaxMode === true && model.supportsNonMaxMode !== true,
      };
      const candidate: CursorModel = {
        id: name,
        name: displayName,
        reasoning: model.supportsThinking === true,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS,
        defaultSelection: flatSelection,
        variants: {},
      };
      const existing = output.get(name);
      if (!existing) {
        output.set(name, { model: candidate, rank: 0, sourceName: name });
      }
      continue;
    }

    for (const group of groups.values()) {
      const variantsByEffort = Object.fromEntries(
        group.selections
          .filter((entry): entry is AvailableSelection & { effort: string } =>
            Boolean(entry.effort),
          )
          .sort((a, b) => compareVariantDisplayOrder(a.effort, b.effort))
          .map((entry) => [entry.effort, entry.selection]),
      );
      const defaultEntry =
        group.selections.find((entry) => entry.isDefault) ??
        selectDefaultAvailableSelection(group.selections);
      if (!defaultEntry) continue;
      let publicId = group.id;
      if (
        group.id !== name &&
        (declaredNames.has(publicId) || output.has(publicId))
      ) {
        const disambiguatedBase = `${group.id}-from-${normalizeIdPart(name)}`;
        publicId = disambiguatedBase;
        let suffix = 2;
        while (declaredNames.has(publicId) || output.has(publicId)) {
          publicId = `${disambiguatedBase}-${suffix++}`;
        }
      }
      const candidate: CursorModel = {
        id: publicId,
        name: group.name,
        reasoning: Object.keys(variantsByEffort).length > 0,
        contextWindow: group.contextWindow,
        maxTokens: DEFAULT_MAX_TOKENS,
        defaultSelection: defaultEntry.selection,
        variants: variantsByEffort,
      };
      const rank = publicId === name ? 0 : 1;
      const existing = output.get(publicId);
      if (
        !existing ||
        rank < existing.rank ||
        (rank === existing.rank && name.localeCompare(existing.sourceName) < 0)
      ) {
        output.set(publicId, { model: candidate, rank, sourceName: name });
      }
    }
  }

  return [...output.values()]
    .map((entry) => entry.model)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function selectDefaultAvailableSelection(
  selections: readonly AvailableSelection[],
): AvailableSelection | undefined {
  for (const key of DEFAULT_VARIANT_ORDER) {
    const match = selections.find((selection) => selection.effort === key);
    if (match) return match;
  }
  return selections[0];
}

function parseParameterValues(value: unknown): CursorModelParameter[] {
  if (!Array.isArray(value)) return [];
  const parameters: CursorModelParameter[] = [];
  for (const raw of value) {
    const record = asRecord(raw);
    const id = stringProp(record, "id");
    const parameterValue = record?.value;
    if (!id) continue;
    if (
      typeof parameterValue !== "string" &&
      typeof parameterValue !== "boolean" &&
      typeof parameterValue !== "number"
    ) {
      continue;
    }
    parameters.push({ id, value: String(parameterValue) });
  }
  return parameters;
}

function parameterDefinitionValues(
  definition: Record<string, unknown> | undefined,
): Array<{ value: string; displayName?: string }> {
  if (!definition) return [];
  const type = asRecord(definition.parameterType);
  const enumParameter = asRecord(type?.enumParameter);
  const booleanParameter = asRecord(type?.booleanParameter);
  return [
    ...arrayProp(enumParameter, "values"),
    ...arrayProp(booleanParameter, "values"),
  ]
    .map(asRecord)
    .flatMap((record) => {
      const value = record?.value;
      if (
        typeof value !== "string" &&
        typeof value !== "boolean" &&
        typeof value !== "number"
      ) {
        return [];
      }
      return [{
        value: String(value),
        displayName: stringProp(record, "displayName"),
      }];
    });
}

function buildStructuralParameterMetadata(
  definitions: readonly Record<string, unknown>[],
  variants: readonly Record<string, unknown>[],
): ParameterMetadata[] {
  const metadata = new Map<string, ParameterMetadata>();
  for (const [index, definition] of definitions.entries()) {
    const id = stringProp(definition, "id");
    if (!id || id === "reasoning" || id === "effort") continue;
    const values = parameterDefinitionValues(definition);
    metadata.set(id, {
      id,
      baseline: values[0]?.value,
      labels: new Map(
        values.map((value) => [
          value.value,
          value.displayName ?? value.value,
        ]),
      ),
      order: index,
      declared: true,
    });
  }

  for (const variant of variants) {
    for (const parameter of parseParameterValues(variant.parameterValues)) {
      if (parameter.id === "reasoning" || parameter.id === "effort") continue;
      const existing = metadata.get(parameter.id);
      if (existing) {
        existing.baseline ??= parameter.value;
        continue;
      }
      metadata.set(parameter.id, {
        id: parameter.id,
        baseline: parameter.value,
        labels: new Map(),
        order: definitions.length + metadata.size,
        declared: false,
      });
    }
  }

  const priority = (id: string): number => {
    if (id === "context") return 0;
    if (id === "thinking") return 1;
    if (id === "fast") return 2;
    return 3;
  };
  return [...metadata.values()].sort(
    (a, b) => priority(a.id) - priority(b.id) || a.order - b.order,
  );
}

function buildStructuralParts(
  values: ReadonlyMap<string, string>,
  metadata: readonly ParameterMetadata[],
): Array<{ id: string; name: string }> {
  const parts: Array<{ id: string; name: string }> = [];
  for (const parameter of metadata) {
    const value = values.get(parameter.id);
    if (value === undefined) {
      if (parameter.declared) continue;
      parts.push({
        id: `${normalizeIdPart(parameter.id)}-unset`,
        name: `${parameter.id} Unset`,
      });
      continue;
    }
    if (value === parameter.baseline) continue;
    const label = parameter.labels.get(value);
    if (parameter.id === "context") {
      parts.push({
        id: normalizeIdPart(value),
        name: label ?? value.toUpperCase(),
      });
      continue;
    }
    if (parameter.id === "thinking" || parameter.id === "fast") {
      const title = parameter.id === "thinking" ? "Thinking" : "Fast";
      parts.push({
        id: value === "true" ? parameter.id : `${parameter.id}-${normalizeIdPart(value)}`,
        name: value === "true" ? title : `${title} ${label ?? value}`,
      });
      continue;
    }
    parts.push({
      id: `${normalizeIdPart(parameter.id)}-${normalizeIdPart(value)}`,
      name: label ?? `${parameter.id} ${value}`,
    });
  }
  return parts;
}

function structuralParameterSignature(
  values: ReadonlyMap<string, string>,
  metadata: readonly ParameterMetadata[],
): string {
  return JSON.stringify(
    metadata.map((parameter) =>
      values.has(parameter.id)
        ? [parameter.id, "present", values.get(parameter.id)]
        : parameter.declared && parameter.baseline !== undefined
          ? [parameter.id, "present", parameter.baseline]
        : [parameter.id, "missing"],
    ),
  );
}

function normalizeEffort(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "extra-high") return "xhigh";
  return VARIANT_DESCRIPTORS.some((descriptor) => descriptor.key === normalized)
    ? normalized
    : undefined;
}

function compareVariantDisplayOrder(a: string, b: string): number {
  const rank = (value: string): number => {
    const index = VARIANT_DISPLAY_ORDER.indexOf(
      value as (typeof VARIANT_DISPLAY_ORDER)[number],
    );
    return index === -1 ? VARIANT_DISPLAY_ORDER.length : index;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}

function normalizeIdPart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function parseTokenLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/,/g, "");
  const match = normalized.match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const multiplier = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  return Math.round(amount * multiplier);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringProp(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function arrayProp(
  record: Record<string, unknown> | undefined,
  key: string,
): unknown[] {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}

export function normalizeCursorModels(
  models: readonly unknown[],
): CursorModel[] {
  if (models.length === 0) return [];

  const byId = new Map<string, CursorModel>();
  for (const model of models) {
    const normalized = normalizeSingleModel(model);
    if (normalized) byId.set(normalized.id, normalized);
  }

  return groupCursorModelVariants([...byId.values()]);
}

function normalizeSingleModel(model: unknown): CursorModel | null {
  const parsed = CursorModelDetailsSchema.safeParse(model);
  if (!parsed.success) return null;

  const details = parsed.data;
  const id = details.modelId.trim();
  if (!id) return null;

  return {
    id,
    name: pickDisplayName(details, id),
    reasoning: Boolean(details.thinkingDetails),
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    defaultSelection: literalCursorModelSelection(id),
    variants: {},
  };
}

interface VariantCandidate {
  model: CursorModel;
  baseId: string;
  baseName: string;
  key: string;
}

function groupCursorModelVariants(models: CursorModel[]): CursorModel[] {
  const byId = new Map(models.map((model) => [model.id, model]));
  const groups = new Map<string, VariantCandidate[]>();

  for (const model of models) {
    const candidate = parseVariantCandidate(model);
    if (!candidate) continue;
    const entries = groups.get(candidate.baseId) ?? [];
    entries.push(candidate);
    groups.set(candidate.baseId, entries);
  }

  const viableGroups = [...groups.entries()]
    .filter(([baseId, candidates]) => {
      const memberCount = candidates.length + (byId.has(baseId) ? 1 : 0);
      const uniqueKeys = new Set(candidates.map((candidate) => candidate.key));
      const names = new Set(
        candidates.map((candidate) => normalizeFamilyName(candidate.baseName)),
      );
      const bare = byId.get(baseId);
      if (bare) names.add(normalizeFamilyName(bare.name));
      return (
        memberCount >= 2 &&
        uniqueKeys.size === candidates.length &&
        names.size === 1
      );
    })
    .sort(([a], [b]) => b.length - a.length || a.localeCompare(b));

  const consumed = new Set<string>();
  const grouped: CursorModel[] = [];

  for (const [baseId, candidates] of viableGroups) {
    const availableCandidates = candidates.filter(
      (candidate) => !consumed.has(candidate.model.id),
    );
    const bare = !consumed.has(baseId) ? byId.get(baseId) : undefined;
    if (availableCandidates.length + (bare ? 1 : 0) < 2) continue;
    if (
      new Set(availableCandidates.map((candidate) => candidate.key)).size !==
      availableCandidates.length
    ) {
      continue;
    }
    const availableNames = new Set(
      availableCandidates.map((candidate) =>
        normalizeFamilyName(candidate.baseName),
      ),
    );
    if (bare) availableNames.add(normalizeFamilyName(bare.name));
    if (availableNames.size !== 1) continue;

    const variants = Object.fromEntries(
      availableCandidates
        .sort(compareVariantCandidates)
        .map((candidate) => [candidate.key, candidate.model.defaultSelection]),
    );
    const defaultModel = bare ?? selectDefaultVariant(availableCandidates)?.model;
    if (!defaultModel) continue;

    const members = [
      ...(bare ? [bare] : []),
      ...availableCandidates.map((candidate) => candidate.model),
    ];
    const baseName = bare?.name ?? availableCandidates[0]!.baseName;
    grouped.push({
      id: baseId,
      name: baseName,
      reasoning: members.some((model) => model.reasoning),
      contextWindow: defaultModel.contextWindow,
      maxTokens: defaultModel.maxTokens,
      defaultSelection: defaultModel.defaultSelection,
      variants,
    });

    for (const member of members) consumed.add(member.id);
  }

  for (const model of models) {
    if (!consumed.has(model.id)) grouped.push(model);
  }

  return grouped.sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeFamilyName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function parseVariantCandidate(model: CursorModel): VariantCandidate | undefined {
  const lowerId = model.id.toLowerCase();
  const lowerName = model.name.toLowerCase();

  for (const descriptor of VARIANT_DESCRIPTORS) {
    const thinkingIdSuffix = descriptor.idSuffixes.find((suffix) =>
      lowerId.endsWith(`${suffix}-thinking`),
    );
    if (thinkingIdSuffix) {
      const thinkingNameSuffix = descriptor.nameSuffixes.find((suffix) =>
        lowerName.endsWith(`${suffix.toLowerCase()} thinking`),
      );
      if (thinkingNameSuffix) {
        const fullIdSuffix = `${thinkingIdSuffix}-thinking`;
        const fullNameSuffix = `${thinkingNameSuffix} Thinking`;
        const idStem = model.id.slice(0, -fullIdSuffix.length);
        const nameStem = model.name.slice(0, -fullNameSuffix.length).trim();
        if (!idStem || !nameStem) return undefined;
        const baseId = `${idStem}-thinking`;
        const baseName = `${nameStem} Thinking`;
        return { model, baseId, baseName, key: descriptor.key };
      }
    }

    const idSuffix = descriptor.idSuffixes.find((suffix) => lowerId.endsWith(suffix));
    if (!idSuffix) continue;
    const nameSuffix = descriptor.nameSuffixes.find((suffix) =>
      lowerName.endsWith(suffix.toLowerCase()),
    );
    if (!nameSuffix) continue;

    const baseId = model.id.slice(0, -idSuffix.length);
    const baseName = model.name.slice(0, -nameSuffix.length).trim();
    if (!baseId || !baseName) return undefined;
    return { model, baseId, baseName, key: descriptor.key };
  }

  return undefined;
}

function compareVariantCandidates(a: VariantCandidate, b: VariantCandidate): number {
  const order = (key: string): number => {
    const index = DEFAULT_VARIANT_ORDER.indexOf(
      key as (typeof DEFAULT_VARIANT_ORDER)[number],
    );
    return index === -1 ? DEFAULT_VARIANT_ORDER.length : index;
  };
  return order(a.key) - order(b.key) || a.key.localeCompare(b.key);
}

function selectDefaultVariant(
  candidates: readonly VariantCandidate[],
): VariantCandidate | undefined {
  return [...candidates].sort(compareVariantCandidates)[0];
}

export function resolveCursorModelSelection(
  models: readonly CursorModel[],
  modelId: string,
  variant: string | undefined,
): CursorModelSelection | undefined {
  const model = models.find((candidate) => candidate.id === modelId);
  if (!model) return undefined;
  const key = variant?.trim().toLowerCase();
  if (!key || key === "default") return model.defaultSelection;
  return model.variants[key] ?? model.defaultSelection;
}

function pickDisplayName(model: CursorModelDetails, fallbackId: string): string {
  const candidates = [
    model.displayName,
    model.displayNameShort,
    model.displayModelId,
    ...model.aliases,
    fallbackId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return fallbackId;
}

function pickAvailableDisplayName(
  model: Record<string, unknown>,
  fallbackName: string,
): string {
  const tooltip = asRecord(model.tooltipData);
  const tooltipTitle = parseTooltipTitle(stringProp(tooltip, "markdownContent"));
  const explicit =
    stringProp(model, "clientDisplayName") ?? tooltipTitle;
  if (explicit) return explicit;

  const shortName = stringProp(model, "inputboxShortModelName");
  if (shortName && !looksLikeModelSlug(shortName)) return shortName;

  return formatModelIdDisplayName(fallbackName);
}

function looksLikeModelSlug(value: string): boolean {
  return value === value.toLowerCase() && value.includes("-");
}

function parseTooltipTitle(markdown: string | undefined): string | undefined {
  const match = markdown?.match(/\*\*([^*]+)\*\*/);
  return match?.[1]?.trim();
}

function formatModelIdDisplayName(id: string): string {
  const grokVersion = id.match(/^grok-(\d+)-(\d+)$/);
  if (grokVersion && grokVersion[2].length <= 2) {
    return `Grok ${grokVersion[1]}.${grokVersion[2]}`;
  }
  const grokDotted = id.match(/^grok-(\d+\.\d+)$/);
  if (grokDotted) return `Grok ${grokDotted[1]}`;
  return id
    .split("-")
    .map((part) =>
      /^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(" ");
}
