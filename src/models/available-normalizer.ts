import type {
  CursorModel,
  CursorModelParameter,
  CursorModelSelection,
} from "../model-selection.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
} from "../shared/constants.js";
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
