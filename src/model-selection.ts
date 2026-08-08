import { Buffer } from "node:buffer";

export const CURSOR_SELECTION_HEADER = "x-opencode-cursor-selection";

export interface CursorModelParameter {
  id: string;
  value: string;
}

export interface CursorModelSelection {
  publicId: string;
  modelId: string;
  displayName: string;
  parameters: CursorModelParameter[];
  maxMode: boolean;
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

export function encodeCursorModelSelection(
  selection: CursorModelSelection,
): string {
  return Buffer.from(JSON.stringify(selection), "utf8").toString("base64url");
}

export function decodeCursorModelSelection(
  encoded: string | undefined,
): CursorModelSelection | undefined {
  if (!encoded || encoded.length > 8_192) return undefined;
  try {
    const value = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (
      typeof record.publicId !== "string" ||
      !record.publicId.trim() ||
      typeof record.modelId !== "string" ||
      !record.modelId.trim() ||
      typeof record.displayName !== "string" ||
      typeof record.maxMode !== "boolean" ||
      !Array.isArray(record.parameters) ||
      record.parameters.length > 32
    ) {
      return undefined;
    }

    const parameters: CursorModelParameter[] = [];
    for (const parameter of record.parameters) {
      if (!parameter || typeof parameter !== "object" || Array.isArray(parameter)) {
        return undefined;
      }
      const item = parameter as Record<string, unknown>;
      if (
        typeof item.id !== "string" ||
        !item.id.trim() ||
        item.id.length > 128 ||
        typeof item.value !== "string" ||
        item.value.length > 256
      ) {
        return undefined;
      }
      parameters.push({ id: item.id, value: item.value });
    }

    return {
      publicId: record.publicId,
      modelId: record.modelId,
      displayName: record.displayName,
      parameters,
      maxMode: record.maxMode,
    };
  } catch {
    return undefined;
  }
}

export function literalCursorModelSelection(modelId: string): CursorModelSelection {
  return {
    publicId: modelId,
    modelId,
    displayName: modelId,
    parameters: [],
    maxMode: false,
  };
}
