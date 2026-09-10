import { createHash } from "node:crypto";

export interface ReasoningSignature {
  id: string;
  digest: string;
  signature: string;
  modelName: string;
}

export interface OpaqueReasoning {
  digest: string;
  modelName: string;
  blocks: { index: number; offset: number; data: string }[];
}

/** Opaque data is copied verbatim, never decoded or turned into visible text. */
export function opaqueReasoning(value: unknown): OpaqueReasoning[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1024)
    throw new Error("Invalid Cursor opaque reasoning metadata");
  let bytes = 0;
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Invalid Cursor opaque reasoning metadata");
    const info = item as Record<string, unknown>;
    if (
      typeof info.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(info.digest) ||
      typeof info.modelName !== "string" ||
      !info.modelName ||
      info.modelName.length > 256 ||
      !Array.isArray(info.blocks) ||
      !info.blocks.length ||
      info.blocks.length > 1024
    )
      throw new Error("Invalid Cursor opaque reasoning metadata");
    const blocks = info.blocks.map((value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid Cursor opaque reasoning block");
      const block = value as Record<string, unknown>;
      if (
        typeof block.index !== "number" ||
        !Number.isSafeInteger(block.index) ||
        block.index < 0 ||
        block.index > 8192 ||
        typeof block.offset !== "number" ||
        !Number.isSafeInteger(block.offset) ||
        block.offset < 0 ||
        typeof block.data !== "string" ||
        !block.data ||
        block.data.length > 1024 * 1024
      )
        throw new Error("Invalid Cursor opaque reasoning block");
      bytes += Buffer.byteLength(block.data);
      if (bytes > 8 * 1024 * 1024)
        throw new Error("Cursor opaque reasoning capacity exceeded");
      return { index: block.index, offset: block.offset, data: block.data };
    });
    return { digest: info.digest, modelName: info.modelName, blocks };
  });
}
export const reasoningDigest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export function reasoningSignatures(value: unknown): ReasoningSignature[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1024)
    throw new Error("Invalid Cursor reasoning signatures");
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Invalid Cursor reasoning signature");
    const info = item as Record<string, unknown>;
    if (
      typeof info.id !== "string" ||
      info.id.length > 128 ||
      typeof info.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(info.digest) ||
      typeof info.signature !== "string" ||
      !info.signature ||
      info.signature.length > 65536 ||
      typeof info.modelName !== "string" ||
      info.modelName.length > 256
    )
      throw new Error("Invalid Cursor reasoning signature");
    return {
      id: info.id,
      digest: info.digest,
      signature: info.signature,
      modelName: info.modelName,
    };
  });
}
