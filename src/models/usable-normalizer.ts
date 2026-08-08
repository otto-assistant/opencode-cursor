import { tool } from "@opencode-ai/plugin";
import {
  literalCursorModelSelection,
  type CursorModel,
} from "../model-selection.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
} from "../shared/constants.js";
const z = tool.schema;

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
