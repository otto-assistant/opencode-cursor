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

export interface CursorModelRequest {
  modelId: string;
  variant?: string;
}

export function encodeCursorModelRequest(
  request: CursorModelRequest,
): string {
  return Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
}

export function decodeCursorModelRequest(
  encoded: string | undefined,
): CursorModelRequest | undefined {
  if (!encoded || encoded.length > 1_024) return undefined;
  try {
    const value = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (
      typeof record.modelId !== "string" ||
      !record.modelId.trim() ||
      record.modelId.length > 256 ||
      (record.variant !== undefined &&
        (typeof record.variant !== "string" ||
          !record.variant.trim() ||
          record.variant.length > 128))
    ) {
      return undefined;
    }
    return {
      modelId: record.modelId,
      ...(typeof record.variant === "string"
        ? { variant: record.variant }
        : {}),
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
