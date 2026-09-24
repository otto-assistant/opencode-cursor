import { createHash } from "node:crypto";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { callCursorUnaryRpc } from "../cursor-rpc.js";
import {
  GetUsableModelsRequestSchema,
  GetUsableModelsResponseSchema,
} from "../proto/agent_pb.js";
import type { CursorModel } from "../model-selection.js";
import { publishCursorCatalog } from "./publish.js";
import { log } from "../shared/log.js";

const GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";
const AVAILABLE_MODELS_PATH = "/aiserver.v1.AiService/AvailableModels";

async function fetchCursorAvailableRaw(
  apiKey: string,
): Promise<unknown[] | null> {
  try {
    const requestBody = new TextEncoder().encode(
      JSON.stringify({
        isNightly: false,
        excludeMaxNamedModels: false,
        additionalModelNames: [],
        useModelParameters: true,
        useReactModelPicker: true,
      }),
    );
    const response = await callCursorUnaryRpc({
      accessToken: apiKey,
      rpcPath: AVAILABLE_MODELS_PATH,
      requestBody,
      contentType: "application/json",
      connectProtocolVersion: "1",
      timeoutMs: 60_000,
    });
    if (response.timedOut || response.exitCode !== 0 || response.body.length === 0) {
      log.warn("[opencode-cursor] AvailableModels request failed", {
        timedOut: response.timedOut,
        exitCode: response.exitCode,
        responseBytes: response.body.length,
      });
      return null;
    }
    const decoded = JSON.parse(new TextDecoder().decode(response.body)) as unknown;
    const models = asRecord(decoded)?.models;
    if (!Array.isArray(models))
      log.warn("[opencode-cursor] AvailableModels response has no models array");
    return Array.isArray(models) ? models : null;
  } catch (error) {
    log.warn("[opencode-cursor] AvailableModels request could not be decoded", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
}

async function fetchCursorUsableRaw(
  apiKey: string,
): Promise<readonly unknown[] | null> {
  try {
    const requestBody = toBinary(
      GetUsableModelsRequestSchema,
      create(GetUsableModelsRequestSchema, {}),
    );
    const response = await callCursorUnaryRpc({
      accessToken: apiKey,
      rpcPath: GET_USABLE_MODELS_PATH,
      requestBody,
      timeoutMs: 20_000,
    });
    if (response.timedOut || response.exitCode !== 0 || response.body.length === 0) {
      return null;
    }
    return decodeGetUsableModelsResponse(response.body)?.models ?? null;
  } catch {
    return null;
  }
}

const cachedModels = new Map<string, CursorModel[]>();
let cacheGeneration = 0;

export interface CursorCatalogDiscovery {
  models: CursorModel[];
  /** False when only GetUsableModels responded; additional first-party models may be missing. */
  complete: boolean;
}

/**
 * Discover the live Cursor model catalog for this account.
 * A partial discovery is usable but must never be cached as the final catalog.
 */
export async function getCursorModels(apiKey: string): Promise<CursorCatalogDiscovery> {
  const credential = createHash("sha256").update(apiKey).digest("hex");
  const cached = cachedModels.get(credential);
  if (cached) return { models: cached, complete: true };
  const generation = cacheGeneration;
  const usable = await fetchCursorUsableRaw(apiKey);
  const available = await fetchCursorAvailableRaw(apiKey);
  const discovered = publishCursorCatalog(available ?? [], usable ?? []);
  const complete = available !== null && available.length > 0 && usable !== null;
  if (generation !== cacheGeneration) return { models: [], complete: false };
  if (complete && discovered.length > 0 && !cachedModels.has(credential)) {
    cachedModels.set(credential, discovered);
    rememberCursorModels(discovered);
  }
  return {
    models: cachedModels.get(credential) ?? discovered,
    complete: cachedModels.has(credential),
  };
}

let publishedModels: readonly CursorModel[] = [];

export function currentCursorModels(): readonly CursorModel[] {
  return publishedModels;
}

export function rememberCursorModels(models: readonly CursorModel[]): void {
  publishedModels = models;
}

/** Invalidate the in-memory catalog (after login or account change). */
export function clearModelCache(): void {
  cacheGeneration += 1;
  cachedModels.clear();
  publishedModels = [];
}

function decodeGetUsableModelsResponse(payload: Uint8Array): {
  models: readonly unknown[];
} | null {
  try {
    return fromBinary(GetUsableModelsResponseSchema, payload);
  } catch {
    const framedBody = decodeConnectUnaryBody(payload);
    if (!framedBody) return null;
    try {
      return fromBinary(GetUsableModelsResponseSchema, framedBody);
    } catch {
      return null;
    }
  }
}

function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
  if (payload.length < 5) return null;

  let offset = 0;
  while (offset + 5 <= payload.length) {
    const flags = payload[offset]!;
    const view = new DataView(
      payload.buffer,
      payload.byteOffset + offset,
      payload.byteLength - offset,
    );
    const messageLength = view.getUint32(1, false);
    const frameEnd = offset + 5 + messageLength;
    if (frameEnd > payload.length) return null;

    if ((flags & 0b0000_0001) !== 0) return null;

    if ((flags & 0b0000_0010) === 0) {
      return payload.subarray(offset + 5, frameEnd);
    }

    offset = frameEnd;
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
