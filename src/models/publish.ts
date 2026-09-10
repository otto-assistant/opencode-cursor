import type { CursorModel } from "../model-selection.js";
import { normalizeAvailableModels } from "./available-normalizer.js";
import { normalizeCursorModels } from "./usable-normalizer.js";

/**
 * AvailableModels owns the stable OpenCode id (`grok-4.6`) and the parameterized
 * request. Usable models own exact wire ids (`cursor-grok-4.6-xhigh`). Probe
 * echoes of those wire ids are not separate models. A model that appears in
 * only one response is still published.
 */
export function publishCursorCatalog(
  availableRaw: readonly unknown[],
  usableRaw: readonly unknown[],
): CursorModel[] {
  const available = normalizeAvailableModels(availableRaw);
  const usable = normalizeCursorModels(usableRaw);
  const usableWires = usableModelIds(usableRaw);
  applyUsableWireIds(available, usableWires);
  const byId = new Map(available.map((model) => [model.id, model]));

  for (const model of usable) {
    const existing = byId.get(model.id);
    if (existing) {
      for (const [key, selection] of Object.entries(model.variants)) {
        if (!existing.variants[key]) existing.variants[key] = selection;
      }
      continue;
    }
    byId.set(model.id, model);
  }

  return dropCoveredDuplicates([...byId.values()]).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
}

function dropCoveredDuplicates(models: readonly CursorModel[]): CursorModel[] {
  const families = models.filter(
    (model) => Object.keys(model.variants).length > 0,
  );
  const covered = coveredIds(families);
  return models.filter((model) => {
    if (isPrefixedDuplicate(model, models)) return false;
    if (Object.keys(model.variants).length > 0) return true;
    return !isCoveredFlat(model, covered);
  });
}

function isPrefixedDuplicate(
  model: CursorModel,
  models: readonly CursorModel[],
): boolean {
  if (!model.id.startsWith("cursor-")) return false;
  const stable = models.find(
    (candidate) => candidate.id === model.id.slice("cursor-".length),
  );
  if (!stable || stable === model) return false;
  const stableWires = new Set(wireIds(stable));
  const extra = wireIds(model).filter(
    (id) => id !== model.id && id !== stable.id,
  );
  return extra.every((id) => stableWires.has(id));
}

function isCoveredFlat(model: CursorModel, covered: ReadonlySet<string>): boolean {
  return (
    covered.has(model.id) ||
    covered.has(model.defaultSelection.modelId) ||
    covered.has(model.defaultSelection.publicId)
  );
}

function coveredIds(models: readonly CursorModel[]): Set<string> {
  const ids = new Set<string>();
  for (const model of models) {
    ids.add(model.id);
    if (!model.id.startsWith("cursor-")) ids.add(`cursor-${model.id}`);
    for (const id of wireIds(model)) ids.add(id);
  }
  return ids;
}

function usableModelIds(models: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const model of models) {
    if (!model || typeof model !== "object" || Array.isArray(model)) continue;
    const record = model as {
      modelId?: unknown;
      displayModelId?: unknown;
      aliases?: unknown;
    };
    if (typeof record.modelId === "string" && record.modelId.trim()) {
      ids.add(record.modelId.trim());
    }
    if (
      typeof record.displayModelId === "string" &&
      record.displayModelId.trim()
    ) {
      ids.add(record.displayModelId.trim());
    }
    if (Array.isArray(record.aliases)) {
      for (const alias of record.aliases) {
        if (typeof alias === "string" && alias.trim()) ids.add(alias.trim());
      }
    }
  }
  return ids;
}

function applyUsableWireIds(models: readonly CursorModel[], wires: ReadonlySet<string>): void {
  for (const model of models) {
    for (const selection of [model.defaultSelection, ...Object.values(model.variants)]) {
      if (wires.has(selection.publicId)) selection.modelId = selection.publicId;
    }
  }
}

function wireIds(model: CursorModel): string[] {
  return [
    model.defaultSelection.modelId,
    model.defaultSelection.publicId,
    ...Object.values(model.variants).flatMap((selection) => [
      selection.modelId,
      selection.publicId,
    ]),
  ];
}
