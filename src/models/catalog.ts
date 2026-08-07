import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { callCursorUnaryRpc } from "../cursor-rpc.js";
import {
  GetUsableModelsRequestSchema,
  GetUsableModelsResponseSchema,
} from "../proto/agent_pb.js";
import { normalizeAvailableModels } from "./available-normalizer.js";
import type { CursorModel } from "../model-selection.js";
import { normalizeCursorModels } from "./usable-normalizer.js";

const GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";
const AVAILABLE_MODELS_PATH = "/aiserver.v1.AiService/AvailableModels";

// Cursor's AvailableModels omits some catalog entries unless they are named
// explicitly. Grok models are user-added and never appear with an empty list.
const ADDITIONAL_MODEL_NAMES = [
  "grok-4-5",
  "grok-4.20",
  "grok-code-fast-1",
  "grok-4-fast-reasoning",
  "grok-4-0709",
] as const;

async function fetchCursorAvailableModels(
  apiKey: string,
): Promise<CursorModel[] | null> {
  try {
    const requestBody = new TextEncoder().encode(
      JSON.stringify({
        isNightly: false,
        excludeMaxNamedModels: true,
        additionalModelNames: [...ADDITIONAL_MODEL_NAMES],
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
    });
    if (response.timedOut || response.exitCode !== 0 || response.body.length === 0) {
      return null;
    }

    const decoded = JSON.parse(new TextDecoder().decode(response.body)) as unknown;
    const record = asRecord(decoded);
    const models = Array.isArray(record?.models)
      ? normalizeAvailableModels(record.models)
      : [];
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

async function fetchCursorUsableModels(
  apiKey: string,
): Promise<CursorModel[] | null> {
  try {
    const requestPayload = create(GetUsableModelsRequestSchema, {});
    const requestBody = toBinary(GetUsableModelsRequestSchema, requestPayload);

    const response = await callCursorUnaryRpc({
      accessToken: apiKey,
      rpcPath: GET_USABLE_MODELS_PATH,
      requestBody,
    });

    if (response.timedOut || response.exitCode !== 0 || response.body.length === 0) {
      return null;
    }

    const decoded = decodeGetUsableModelsResponse(response.body);
    if (!decoded) return null;

    const models = normalizeCursorModels(decoded.models);
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

let cachedModels: CursorModel[] | null = null;

/**
 * Discover the live Cursor model catalog for this account.
 * Returns [] on failure — never invents a hardcoded catalog.
 */
export async function getCursorModels(apiKey: string): Promise<CursorModel[]> {
  if (cachedModels) return cachedModels;
  const discovered =
    (await fetchCursorAvailableModels(apiKey)) ??
    (await fetchCursorUsableModels(apiKey));
  if (discovered && discovered.length > 0) {
    cachedModels = discovered;
    return cachedModels;
  }
  return [];
}

/** Invalidate the in-memory catalog (after login or account change). */
export function clearModelCache(): void {
  cachedModels = null;
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
