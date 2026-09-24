import type { CursorModel, CursorModelSelection } from "../model-selection.js";

const EFFORTS = [
  { key: "xhigh", id: ["extra-high", "xhigh"], name: [" Extra High", " XHigh", " X High"] },
  { key: "medium", id: ["medium"], name: [" Medium"] },
  { key: "default", id: ["default"], name: [" Default"] },
  { key: "none", id: ["none"], name: [" None"] },
  { key: "minimal", id: ["minimal"], name: [" Minimal"] },
  { key: "high", id: ["high"], name: [" High"] },
  { key: "max", id: ["max"], name: [" Max"] },
  { key: "low", id: ["low"], name: [" Low"] },
] as const;

const DEFAULT_VARIANT_ORDER = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

interface EffortAlias {
  familyId: string;
  key: string;
  thinking: boolean;
}

interface AliasEntry {
  model: CursorModel;
  alias: EffortAlias;
}

/** Group Cursor IDs into one family: none is non-thinking, other keys are thinking effort. */
export function groupEffortFamilies(models: readonly CursorModel[]): CursorModel[] {
  const byId = new Map(models.map((model) => [model.id, model]));
  const aliases = new Map<string, AliasEntry[]>();

  for (const model of models) {
    if (Object.keys(model.variants).length > 0) continue;
    const alias = parseEffortAlias(model.id);
    if (!alias) continue;
    const entries = aliases.get(alias.familyId) ?? [];
    entries.push({ model, alias });
    aliases.set(alias.familyId, entries);
  }

  const consumed = new Set<string>();
  const grouped: CursorModel[] = [];
  const families = [...aliases.keys()].sort(
    (a, b) => b.length - a.length || a.localeCompare(b),
  );

  for (const familyId of families) {
    const entries = (aliases.get(familyId) ?? []).filter(
      (entry) => !consumed.has(entry.model.id),
    );
    const family = !consumed.has(familyId) ? byId.get(familyId) : undefined;
    const thinking = entries.filter((entry) => entry.alias.thinking);
    const plain = entries.filter((entry) => !entry.alias.thinking);
    const built =
      thinking.length > 0
        ? groupThinkingFamily(familyId, family, plain, thinking)
        : groupPlainFamily(familyId, family, plain);
    if (!built) continue;
    grouped.push(built.model);
    for (const id of built.consumed) consumed.add(id);
  }

  for (const model of models) {
    if (!consumed.has(model.id)) grouped.push(model);
  }
  return stabilizeFamilyIds(grouped).sort((a, b) => a.id.localeCompare(b.id));
}

/** Usable wire IDs often look like `cursor-grok-4.6-high`. OpenCode keeps `grok-4.6`. */
function stabilizeFamilyIds(models: CursorModel[]): CursorModel[] {
  const ids = new Set(models.map((model) => model.id));
  return models.map((model) => {
    if (!model.id.startsWith("cursor-") || keepsCursorPrefix(model)) return model;
    const stable = model.id.slice("cursor-".length);
    if (!stable || ids.has(stable)) return model;
    ids.delete(model.id);
    ids.add(stable);
    return { ...model, id: stable };
  });
}

function keepsCursorPrefix(model: CursorModel): boolean {
  return /^cursor\s/i.test(model.name.trim());
}

export function parseEffortAlias(id: string): EffortAlias | undefined {
  const lower = id.toLowerCase();
  const tokens = EFFORTS.flatMap((effort) =>
    effort.id.map((token) => ({ key: effort.key, token })),
  ).sort((a, b) => b.token.length - a.token.length);

  for (const { key, token } of tokens) {
    if (lower.endsWith(`-thinking-${token}`)) {
      const familyId = id.slice(0, -(token.length + 10));
      return familyId ? { familyId, key, thinking: true } : undefined;
    }
    if (lower.endsWith(`-${token}-thinking`)) {
      const familyId = id.slice(0, -(token.length + 10));
      return familyId ? { familyId, key, thinking: true } : undefined;
    }
    if (lower.endsWith(`-${token}`)) {
      const familyId = id.slice(0, -(token.length + 1));
      return familyId ? { familyId, key, thinking: false } : undefined;
    }
  }
  return undefined;
}

function groupThinkingFamily(
  familyId: string,
  family: CursorModel | undefined,
  plain: readonly AliasEntry[],
  thinking: readonly AliasEntry[],
): { model: CursorModel; consumed: string[] } | undefined {
  const variants: Record<string, CursorModelSelection> = {};
  for (const entry of thinking) {
    if (!variants[entry.alias.key]) variants[entry.alias.key] = entry.model.defaultSelection;
  }
  const none = pickNone(family, plain);
  if (none) variants.none = none;
  if (Object.keys(variants).length < 2) return undefined;

  const defaultSelection =
    variants.none ??
    DEFAULT_VARIANT_ORDER.map((key) => variants[key]).find(Boolean);
  if (!defaultSelection) return undefined;

  const members = [
    ...thinking.map((entry) => entry.model),
    ...plain.map((entry) => entry.model),
    ...(family ? [family] : []),
  ];
  return {
    model: {
      id: familyId,
      name: stripThinkingLabel(family?.name ?? familyName(plain, thinking)),
      reasoning: true,
      contextWindow: family?.contextWindow ?? members[0]!.contextWindow,
      maxTokens: family?.maxTokens ?? members[0]!.maxTokens,
      defaultSelection,
      variants,
    },
    consumed: [...members.map((model) => model.id), familyId],
  };
}

function groupPlainFamily(
  familyId: string,
  family: CursorModel | undefined,
  plain: readonly AliasEntry[],
): { model: CursorModel; consumed: string[] } | undefined {
  const unique = new Map<string, CursorModel>();
  for (const entry of plain) {
    if (!unique.has(entry.alias.key)) unique.set(entry.alias.key, entry.model);
  }
  if (unique.size + (family ? 1 : 0) < 2) return undefined;

  const variants: Record<string, CursorModelSelection> = {
    ...(family?.variants ?? {}),
  };
  for (const [key, model] of unique) {
    if (!variants[key]) variants[key] = model.defaultSelection;
  }
  const defaultModel =
    family ??
    DEFAULT_VARIANT_ORDER.map((key) => unique.get(key)).find(Boolean);
  if (!defaultModel) return undefined;

  const members = [...unique.values(), ...(family ? [family] : [])];
  return {
    model: {
      id: familyId,
      name: family?.name ?? familyName(plain, []),
      reasoning: true,
      contextWindow: family?.contextWindow ?? defaultModel.contextWindow,
      maxTokens: family?.maxTokens ?? defaultModel.maxTokens,
      defaultSelection: family?.defaultSelection ?? defaultModel.defaultSelection,
      variants,
    },
    consumed: [...members.map((model) => model.id), familyId],
  };
}

function pickNone(
  family: CursorModel | undefined,
  plain: readonly AliasEntry[],
): CursorModelSelection | undefined {
  if (family) return family.defaultSelection;
  const byKey = new Map(
    plain.map((entry) => [entry.alias.key, entry.model.defaultSelection]),
  );
  for (const key of DEFAULT_VARIANT_ORDER) {
    const selection = byKey.get(key);
    if (selection) return selection;
  }
  return plain[0]?.model.defaultSelection;
}

function familyName(
  plain: readonly AliasEntry[],
  thinking: readonly AliasEntry[],
): string {
  for (const key of DEFAULT_VARIANT_ORDER) {
    const entry =
      plain.find((item) => item.alias.key === key) ??
      thinking.find((item) => item.alias.key === key);
    if (entry) return stripEffortLabel(entry.model.name, key);
  }
  const first = plain[0] ?? thinking[0];
  return first ? stripEffortLabel(first.model.name, first.alias.key) : "";
}

function stripThinkingLabel(name: string): string {
  return name.endsWith(" Thinking") ? name.slice(0, -9).trim() : name;
}

function stripEffortLabel(name: string, key: string): string {
  const labels = EFFORTS.find((effort) => effort.key === key)?.name ?? [];
  for (const label of labels) {
    if (name.endsWith(`${label} Thinking`))
      return `${name.slice(0, -`${label} Thinking`.length).trim()} Thinking`;
    if (name.endsWith(label)) return name.slice(0, -label.length).trim();
  }
  return name;
}
