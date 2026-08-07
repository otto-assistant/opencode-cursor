import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { callCursorUnaryRpc, probeCursorAgentSelection } from "../proxy.js";
import {
  GetUsableModelsRequestSchema,
  GetUsableModelsResponseSchema,
} from "../proto/agent_pb.js";
import { normalizeAvailableModels } from "./available-normalizer.js";
import { FALLBACK_MODELS } from "./fallback-catalog.js";
import type { CursorModel } from "./types.js";
import { normalizeCursorModels } from "./usable-normalizer.js";

const GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";
const AVAILABLE_MODELS_PATH = "/aiserver.v1.AiService/AvailableModels";

// Cursor's AvailableModels omits some catalog entries unless they are named
// explicitly. Grok models (including Grok 4.5 / grok-4-5) are user-added
// named models and never appear with an empty additionalModelNames list.
const ADDITIONAL_MODEL_NAMES = [
  "grok-4-5",
  "grok-4.20",
  "grok-code-fast-1",
  "grok-4-fast-reasoning",
  "grok-4-0709",
] as const;

const AGENT_PROBE_MODEL_IDS = new Set<string>(ADDITIONAL_MODEL_NAMES);

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
      ? await filterAgentRunnableModels(
          apiKey,
          normalizeAvailableModels(record.models),
        )
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

export type GetCursorModelsOptions = {
  /**
   * When false, return an empty list instead of the hardcoded FALLBACK_MODELS
   * catalog. Use this for provider/config UI seeding so OpenChamber never shows
   * the bundled ~14 models as if they were the live Cursor catalog (~50).
   */
  allowFallback?: boolean;
};

export async function getCursorModels(
  apiKey: string,
  options?: GetCursorModelsOptions,
): Promise<CursorModel[]> {
  if (cachedModels) return cachedModels;
  const discovered =
    (await fetchCursorAvailableModels(apiKey)) ??
    (await fetchCursorUsableModels(apiKey));
  // Only cache a successful discovery. Caching FALLBACK_MODELS would pin the
  // whole process to the bundled list after a single transient failure; instead
  // return the fallback for this call and let the next call retry discovery.
  if (discovered && discovered.length > 0) {
    cachedModels = discovered;
    return cachedModels;
  }
  if (options?.allowFallback === false) return [];
  return FALLBACK_MODELS;
}

async function filterAgentRunnableModels(
  accessToken: string,
  models: CursorModel[],
): Promise<CursorModel[]> {
  const probeTargets = models.filter((model) => AGENT_PROBE_MODEL_IDS.has(model.id));
  if (probeTargets.length === 0) return models;

  const probeResults = await Promise.all(
    probeTargets.map(async (model) => ({
      id: model.id,
      runnable: await probeCursorAgentSelection(accessToken, model.defaultSelection),
    })),
  );
  const runnableIds = new Set(
    probeResults.filter((result) => result.runnable).map((result) => result.id),
  );

  return models.filter(
    (model) => !AGENT_PROBE_MODEL_IDS.has(model.id) || runnableIds.has(model.id),
  );
}

/** @internal Test-only. */
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

    // Compression flag
    if ((flags & 0b0000_0001) !== 0) return null;

    // End-of-stream flag — skip trailer frames
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
