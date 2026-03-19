/**
 * Cursor model discovery via GetUsableModels gRPC endpoint.
 * Uses curl for HTTP/2 transport (Bun's node:http2 is broken).
 * Falls back to a hardcoded list if the endpoint is unreachable.
 */
import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { z } from "zod";
import {
  GetUsableModelsRequestSchema,
  GetUsableModelsResponseSchema,
} from "./proto/agent_pb";

const CURSOR_BASE_URL = "https://api2.cursor.sh";
const CURSOR_CLIENT_VERSION = "cli-2026.02.13-41ac335";
const GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;

// --- Zod schemas for safe parsing of gRPC response ---

const CursorModelDetailsSchema = z.object({
  modelId: z.string(),
  displayName: z.string().optional().catch(undefined),
  displayNameShort: z.string().optional().catch(undefined),
  displayModelId: z.string().optional().catch(undefined),
  aliases: z
    .array(z.unknown())
    .optional()
    .catch([])
    .transform((aliases) =>
      (aliases ?? []).filter(
        (alias: unknown): alias is string => typeof alias === "string",
      ),
    ),
  thinkingDetails: z.unknown().optional(),
});

const CursorDecodedResponseSchema = z.object({
  models: z.array(z.unknown()).optional().catch([]),
});

type CursorModelDetails = z.infer<typeof CursorModelDetailsSchema>;

// --- Normalized model type for OpenCode ---

export interface CursorModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

// --- Hardcoded fallback models ---

const FALLBACK_MODELS: CursorModel[] = [
  { id: "composer-2", name: "Composer 2", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
  { id: "claude-4-sonnet", name: "Claude 4 Sonnet", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
  { id: "claude-3.5-sonnet", name: "Claude 3.5 Sonnet", reasoning: false, contextWindow: 200_000, maxTokens: 8_192 },
  { id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128_000, maxTokens: 16_384 },
  { id: "cursor-small", name: "Cursor Small", reasoning: false, contextWindow: 200_000, maxTokens: 64_000 },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536 },
];

export interface CursorModelDiscoveryOptions {
  apiKey: string;
  baseUrl?: string;
  clientVersion?: string;
  timeoutMs?: number;
}

/**
 * Fetch models from Cursor's GetUsableModels gRPC endpoint.
 * Returns null on failure (caller should use fallback list).
 */
export async function fetchCursorUsableModels(
  options: CursorModelDiscoveryOptions,
): Promise<CursorModel[] | null> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  try {
    const requestPayload = create(GetUsableModelsRequestSchema, {});
    const body = toBinary(GetUsableModelsRequestSchema, requestPayload);
    const baseUrl = (options.baseUrl ?? CURSOR_BASE_URL).replace(/\/+$/, "");

    const responseBuffer = await fetchViaHttp2(baseUrl, body, options, timeoutMs);
    if (!responseBuffer) return null;

    const decoded = decodeGetUsableModelsResponse(responseBuffer);
    const parsedDecoded = CursorDecodedResponseSchema.safeParse(decoded);
    if (!parsedDecoded.success) return null;

    return normalizeCursorModels(parsedDecoded.data.models);
  } catch {
    return null;
  }
}

/**
 * Get cursor models: try dynamic discovery, fall back to hardcoded list.
 */
export async function getCursorModels(
  apiKey: string,
): Promise<CursorModel[]> {
  const discovered = await fetchCursorUsableModels({ apiKey });
  return discovered && discovered.length > 0 ? discovered : FALLBACK_MODELS;
}

// --- Internal helpers ---

function buildRequestHeaders(
  options: CursorModelDiscoveryOptions,
): Record<string, string> {
  return {
    "content-type": "application/proto",
    te: "trailers",
    authorization: `Bearer ${options.apiKey}`,
    "x-ghost-mode": "true",
    "x-cursor-client-version":
      options.clientVersion ?? CURSOR_CLIENT_VERSION,
    "x-cursor-client-type": "cli",
  };
}


/**
 * HTTP/2 transport via curl (Bun's node:http2 doesn't work with Cursor's API).
 * Writes request body to a temp file, invokes curl --http2, reads response.
 */
async function fetchViaHttp2(
  baseUrl: string,
  body: Uint8Array,
  options: CursorModelDiscoveryOptions,
  timeoutMs: number,
): Promise<Uint8Array | null> {
  const reqPath = join(tmpdir(), `cursor-req-${Date.now()}.bin`);
  const respPath = join(tmpdir(), `cursor-resp-${Date.now()}.bin`);
  try {
    writeFileSync(reqPath, body);
    const headers = buildRequestHeaders(options);
    const headerArgs = Object.entries(headers)
      .flatMap(([k, v]) => ["-H", `${k}: ${v}`]);
    const timeoutSecs = Math.ceil(timeoutMs / 1000);
    const url = `${baseUrl}${GET_USABLE_MODELS_PATH}`;
    const args = [
      "curl", "-s", "--http2",
      "--max-time", String(timeoutSecs),
      "-X", "POST",
      ...headerArgs,
      "--data-binary", `@${reqPath}`,
      "-o", respPath,
      "-w", "%{http_code}",
      url,
    ];
    const status = execSync(args.map(a => a.includes(' ') ? `"${a}"` : a).join(' '), {
      timeout: timeoutMs + 2000,
      stdio: ["pipe", "pipe", "pipe"],
    }).toString().trim();
    if (!status.startsWith("2")) return null;
    if (!existsSync(respPath)) return null;
    return new Uint8Array(readFileSync(respPath));
  } catch {
    return null;
  } finally {
    try { unlinkSync(reqPath); } catch {}
    try { unlinkSync(respPath); } catch {}
  }
}

function decodeGetUsableModelsResponse(payload: Uint8Array) {
  if (payload.length === 0) return null;

  // Try Connect framing first (5-byte header)
  const framedBody = decodeConnectUnaryBody(payload);
  if (framedBody) {
    try {
      return fromBinary(GetUsableModelsResponseSchema, framedBody);
    } catch {
      return null;
    }
  }

  // Raw protobuf
  try {
    return fromBinary(GetUsableModelsResponseSchema, payload);
  } catch {
    return null;
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
    if (!((flags & 0b0000_0010) !== 0)) {
      return payload.subarray(offset + 5, frameEnd);
    }

    offset = frameEnd;
  }

  return null;
}

function normalizeCursorModels(
  models: readonly unknown[] | undefined,
): CursorModel[] {
  if (!models || models.length === 0) return [];

  const byId = new Map<string, CursorModel>();
  for (const model of models) {
    const normalized = normalizeSingleModel(model);
    if (normalized) byId.set(normalized.id, normalized);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeSingleModel(model: unknown): CursorModel | null {
  const parsed = CursorModelDetailsSchema.safeParse(model);
  if (!parsed.success) return null;

  const details = parsed.data;
  const id = details.modelId.trim();
  if (!id) return null;

  return {
    id,
    name: pickDisplayName(details, id),
    reasoning: Boolean(details.thinkingDetails),
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
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
