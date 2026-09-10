import {
  literalCursorModelSelection,
  type CursorModel,
} from "../model-selection.js";
import { groupEffortFamilies } from "./effort-family.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
} from "../shared/constants.js";

interface CursorModelDetails {
  modelId: string;
  displayName?: string;
  displayNameShort?: string;
  displayModelId?: string;
  aliases: string[];
  thinkingDetails?: unknown;
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

  return groupEffortFamilies([...byId.values()]);
}

function normalizeSingleModel(model: unknown): CursorModel | null {
  const details = parseCursorModelDetails(model);
  if (!details) return null;
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

function parseCursorModelDetails(
  value: unknown,
): CursorModelDetails | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.modelId !== "string") return undefined;
  const optionalString = (key: string): string | undefined =>
    typeof record[key] === "string" ? record[key] : undefined;
  return {
    modelId: record.modelId,
    displayName: optionalString("displayName"),
    displayNameShort: optionalString("displayNameShort"),
    displayModelId: optionalString("displayModelId"),
    aliases: Array.isArray(record.aliases)
      ? record.aliases.filter(
          (alias): alias is string => typeof alias === "string",
        )
      : [],
    thinkingDetails: record.thinkingDetails,
  };
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
