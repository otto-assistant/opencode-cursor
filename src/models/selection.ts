import type { CursorModelSelection } from "../model-selection.js";
import type { CursorModel } from "./types.js";

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
