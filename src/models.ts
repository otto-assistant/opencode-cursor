/** Cursor model discovery and filtering for stateless UnifiedChat. */
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  literalCursorModelSelection,
  type CursorModelParameter,
  type CursorModelSelection,
} from "./model-selection.js";
import {
  UnifiedChatTransport,
  collectTransportBody,
  type CursorTransport,
} from "./unified-chat-transport.js";

const AVAILABLE_MODELS_PATH = "/aiserver.v1.AiService/AvailableModels";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;
const MAX_DISCOVERY_RESPONSE_BYTES = 8 * 1024 * 1024;
const KNOWN_DEPRECATED_MODEL_IDS = new Set(["composer-2"]);
const NON_TEXT_OUTPUT_MODEL_PATTERN =
  /(?:^|[-_.])(?:image(?:gen|generation)?|imagen|realtime|audio|speech|tts|video)(?:[-_.]|$)/;

export interface CursorModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  defaultSelection: CursorModelSelection;
  variants: Record<string, CursorModelSelection>;
}

/**
 * Minimal catalog seeded while logged out. OpenCode removes providers that
 * have zero models from `provider.list()`, which hides Cursor in OpenChamber's
 * provider settings and blocks the OAuth connect button. A single placeholder
 * keeps the provider visible without advertising a fake model catalog.
 *
 * When a live browser login URL is available (OpenChamber does not always
 * surface plugin OAuth methods), embed it in the model name so the user can
 * copy/open it — same flow as `opencode auth login`.
 */
export const LOGIN_PLACEHOLDER_MODELS: CursorModel[] = [
  flatModel(
    "default",
    "Cursor (authorize to load models)",
    false,
    200_000,
    64_000,
  ),
];

export function loginPlaceholderModels(loginUrl?: string): CursorModel[] {
  if (!loginUrl) return LOGIN_PLACEHOLDER_MODELS;
  return [
    flatModel(
      "default",
      `OPEN THIS URL TO LOGIN → ${loginUrl}`,
      false,
      200_000,
      64_000,
    ),
  ];
}

export function isLoginPlaceholderModel(model: CursorModel | undefined): boolean {
  if (!model || model.id !== "default") return false;
  return (
    model.name === LOGIN_PLACEHOLDER_MODELS[0]!.name ||
    model.name.startsWith("OPEN THIS URL TO LOGIN")
  );
}
const SUPPORTED_VARIANT_KEYS = new Set([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

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
  transport: CursorTransport,
): Promise<CursorModel[] | null> {
  try {
    const requestBody = new TextEncoder().encode(
      JSON.stringify({
        isNightly: false,
        excludeMaxNamedModels: true,
        additionalModelNames: [],
        useModelParameters: true,
        useReactModelPicker: true,
      }),
    );
    const response = await transport.request({
      accessToken: apiKey,
      path: AVAILABLE_MODELS_PATH,
      body: requestBody,
      contentType: "application/json",
      connectProtocolVersion: "1",
      timeoutMs: 5_000,
    });
    if (response.status < 200 || response.status >= 300) {
      await response.body.cancel().catch(() => undefined);
      return null;
    }
    const encodedBody = await collectTransportBody(
      response,
      MAX_DISCOVERY_RESPONSE_BYTES,
    );
    const contentEncoding = response.headers
      .get("content-encoding")
      ?.trim()
      .toLowerCase();
    if (contentEncoding && contentEncoding !== "identity" && contentEncoding !== "gzip") {
      return null;
    }
    const body = contentEncoding === "gzip"
      ? gunzipSync(encodedBody, { maxOutputLength: MAX_DISCOVERY_RESPONSE_BYTES })
      : encodedBody;
    if (body.length === 0) return null;
    const decoded = JSON.parse(new TextDecoder().decode(body)) as unknown;
    const record = asRecord(decoded);
    const models = Array.isArray(record?.models)
      ? filterSupportedCursorModels(normalizeAvailableModels(record.models))
      : [];
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

let defaultDiscoveryTransport: UnifiedChatTransport | undefined;
const cachedModels = new Map<string, CursorModel[]>();

function discoveryTransport(): CursorTransport {
  defaultDiscoveryTransport ??= new UnifiedChatTransport({ minSize: 0 });
  return defaultDiscoveryTransport;
}

function tokenCacheKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

export function isSupportedCursorSelection(
  selection: CursorModelSelection,
  model?: CursorModel,
): boolean {
  const id = selection.publicId.trim().toLowerCase();
  return (
    (!selection.maxMode || (model !== undefined && isExplicitOneMillionContextSelection(model, selection))) &&
    /^(?:claude|gpt|gemini)(?:-|$)/.test(id) &&
    !NON_TEXT_OUTPUT_MODEL_PATTERN.test(id) &&
    !KNOWN_DEPRECATED_MODEL_IDS.has(id)
  );
}

export function filterSupportedCursorModels(
  models: readonly CursorModel[],
): CursorModel[] {
  const supported = models.flatMap((model) => {
    const variants = Object.fromEntries(
      Object.entries(model.variants).filter(([, selection]) =>
        isSupportedCursorSelection(selection, model),
      ),
    );
    const defaultSelection = isSupportedCursorSelection(
      model.defaultSelection,
      model,
    )
      ? model.defaultSelection
      : Object.values(variants)[0];
    if (!defaultSelection) return [];
    return [{ ...model, defaultSelection, variants }];
  });
  return removeAmbiguousSelectionIds(supported);
}

export function isExplicitOneMillionContextSelection(
  model: CursorModel,
  selection: CursorModelSelection,
): boolean {
  return (
    selection.maxMode &&
    model.contextWindow === 1_000_000 &&
    /(?:^|-)1m(?:-|$)/.test(model.id.toLowerCase()) &&
    selection.parameters.some((parameter) =>
      parameter.id.toLowerCase() === "context" &&
      parameter.value.trim().toLowerCase() === "1m"
    )
  );
}

function removeAmbiguousSelectionIds(models: readonly CursorModel[]): CursorModel[] {
  const owners = new Map<string, Set<string>>();
  for (const model of models) {
    for (const selection of [
      model.defaultSelection,
      ...Object.values(model.variants),
    ]) {
      const key = selectionWireKey(selection);
      const entries = owners.get(key) ?? new Set<string>();
      entries.add(`${model.id}\0${selectionSignature(selection)}`);
      owners.set(key, entries);
    }
  }
  const ambiguous = new Set(
    [...owners.entries()]
      .filter(([, entries]) => entries.size > 1)
      .map(([key]) => key),
  );
  return models.flatMap((model) => {
    const variants = Object.fromEntries(
      Object.entries(model.variants).filter(
        ([, selection]) => !ambiguous.has(selectionWireKey(selection)),
      ),
    );
    const defaultSelection = ambiguous.has(selectionWireKey(model.defaultSelection))
      ? Object.values(variants)[0]
      : model.defaultSelection;
    return defaultSelection ? [{ ...model, defaultSelection, variants }] : [];
  });
}

function selectionWireKey(selection: CursorModelSelection): string {
  return JSON.stringify([selection.publicId, selection.maxMode]);
}

function selectionSignature(selection: CursorModelSelection): string {
  return JSON.stringify([
    selection.modelId,
    selection.maxMode,
    selection.parameters.map((parameter) => [parameter.id, parameter.value]),
  ]);
}

function modelRoutingSignature(model: CursorModel): string {
  return JSON.stringify([
    model.defaultSelection.publicId,
    selectionSignature(model.defaultSelection),
    Object.entries(model.variants).map(([key, selection]) => [
      key,
      selection.publicId,
      selectionSignature(selection),
    ]),
  ]);
}

export async function getCursorModels(
  apiKey: string,
  transport: CursorTransport = discoveryTransport(),
): Promise<CursorModel[]> {
  const key = tokenCacheKey(apiKey);
  const cached = cachedModels.get(key);
  if (cached) return cached;
  const discovered = await fetchCursorAvailableModels(apiKey, transport);
  if (discovered && discovered.length > 0) {
    cachedModels.set(key, discovered);
    return discovered;
  }
  return [];
}

/** @internal Test-only. */
export function clearModelCache(): void {
  cachedModels.clear();
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
  const ambiguousModelIds = new Set<string>();

  for (const rawModel of models) {
    const model = asRecord(rawModel);
    const name = stringProp(model, "name");
    if (!model || !name || isDeprecatedAvailableModel(model, name)) continue;

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
      const structuralParts = buildStructuralParts(
        values,
        structuralParameters,
        variant.isMaxMode === true,
      );
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
      const legacySlug = stringProp(variant, "legacySlug");
      if (!legacySlug) continue;
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
      if (variants.length > 0) continue;
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
      } else if (
        modelRoutingSignature(existing.model) !== modelRoutingSignature(candidate)
      ) {
        ambiguousModelIds.add(name);
      }
      continue;
    }

    for (const group of groups.values()) {
      const publicIdCounts = new Map<string, number>();
      for (const entry of group.selections) {
        const publicId = entry.selection.publicId;
        publicIdCounts.set(publicId, (publicIdCounts.get(publicId) ?? 0) + 1);
      }
      const selections = group.selections.filter(
        (entry) => publicIdCounts.get(entry.selection.publicId) === 1,
      );
      const variantsByEffort = Object.fromEntries(
        selections
          .filter((entry): entry is AvailableSelection & { effort: string } =>
            Boolean(entry.effort),
          )
          .sort((a, b) => compareVariantDisplayOrder(a.effort, b.effort))
          .map((entry) => [entry.effort, entry.selection]),
      );
      const defaultEntry =
        selections.find((entry) => entry.isDefault) ??
        selectDefaultAvailableSelection(selections);
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
        existing &&
        modelRoutingSignature(existing.model) !== modelRoutingSignature(candidate)
      ) {
        ambiguousModelIds.add(publicId);
      }
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
    .filter((model) => !ambiguousModelIds.has(model.id))
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
      baseline:
        id === "context"
          ? nonMaxParameterValue(id, variants) ?? values[0]?.value
          : values[0]?.value,
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

function nonMaxParameterValue(
  id: string,
  variants: readonly Record<string, unknown>[],
): string | undefined {
  const ordered = [
    ...variants.filter((variant) => variant.isDefaultNonMaxConfig === true),
    ...variants.filter((variant) => variant.isDefaultNonMaxConfig !== true),
  ];
  for (const variant of ordered) {
    if (variant.isMaxMode === true) continue;
    const parameter = parseParameterValues(variant.parameterValues)
      .find((candidate) => candidate.id === id);
    if (parameter) return parameter.value;
  }
  return undefined;
}

function buildStructuralParts(
  values: ReadonlyMap<string, string>,
  metadata: readonly ParameterMetadata[],
  maxMode: boolean,
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
    const forceMaxContext = maxMode && parameter.id === "context";
    if (value === parameter.baseline && !forceMaxContext) continue;
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
  return SUPPORTED_VARIANT_KEYS.has(normalized)
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

function isDeprecatedAvailableModel(
  model: Record<string, unknown>,
  name: string,
): boolean {
  return (
    model.isDeprecated === true ||
    model.deprecated === true ||
    stringProp(model, "status")?.toLowerCase() === "deprecated" ||
    KNOWN_DEPRECATED_MODEL_IDS.has(name.toLowerCase())
  );
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
  return model.variants[key];
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
