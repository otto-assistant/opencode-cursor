import { randomBytes } from "node:crypto";
import {
  BridgePool,
  type BridgePoolRequest,
} from "./bridge-pool.js";

const DEFAULT_UPSTREAM_URL = "https://api2.cursor.sh";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_TIMEOUT_MS = 2_147_482_897;
const PROCESS_MACHINE_ID = randomBytes(32).toString("hex");

export type CursorContentType =
  | "application/connect+proto"
  | "application/json"
  | "application/proto";

export interface CursorTransportRequest {
  accessToken: string;
  path: string;
  body: Uint8Array;
  url?: string;
  contentType?: CursorContentType;
  connectProtocolVersion?: "1";
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CursorTransportResponse {
  status: number;
  headers: Headers;
  trailers: Promise<Headers>;
  body: ReadableStream<Uint8Array>;
}

export interface CursorTransport {
  request(request: CursorTransportRequest): Promise<CursorTransportResponse>;
  close?(): void;
}

function validateOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Cursor transport URL must be a valid HTTP(S) origin");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new TypeError("Cursor transport URL must be a valid HTTP(S) origin");
  }
  return url.origin;
}

function validateMachineId(value: string): string {
  if (value.length === 0 || value.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new TypeError("machineId contains unsupported characters");
  }
  return value;
}

function validateRequest(request: CursorTransportRequest): void {
  if (typeof request.accessToken !== "string" || request.accessToken.length === 0 || /[\r\n]/.test(request.accessToken)) {
    throw new TypeError("accessToken must be a non-empty header-safe string");
  }
  if (typeof request.path !== "string" || !request.path.startsWith("/") || request.path.length > 16 * 1024 || /[\r\n]/.test(request.path)) {
    throw new TypeError("path must be an absolute HTTP/2 path");
  }
  if (!(request.body instanceof Uint8Array)) throw new TypeError("body must be a Uint8Array");
  if (request.body.byteLength > MAX_BODY_BYTES) throw new RangeError("Request body exceeds the 32 MiB limit");
  if (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > MAX_TIMEOUT_MS)) {
    throw new RangeError("timeoutMs must be a positive 32-bit integer");
  }
  const contentType = request.contentType ?? "application/connect+proto";
  if (
    contentType !== "application/connect+proto"
    && contentType !== "application/json"
    && contentType !== "application/proto"
  ) {
    throw new TypeError("Unsupported Cursor content type");
  }
}

function cleanAccessToken(value: string): string {
  const separator = value.indexOf("::");
  return separator >= 0 ? value.slice(separator + 2) : value;
}

export class UnifiedChatTransport implements CursorTransport {
  private readonly pool: BridgePool;
  private readonly url: string;
  private readonly machineId: string;

  constructor(options: {
    minSize?: number;
    maxSize?: number;
    url?: string;
    machineId?: string;
  } = {}) {
    this.url = validateOrigin(options.url ?? DEFAULT_UPSTREAM_URL);
    this.machineId = validateMachineId(options.machineId ?? PROCESS_MACHINE_ID);
    this.pool = new BridgePool({ minSize: options.minSize, maxSize: options.maxSize });
    this.pool.warmup();
  }

  async request(request: CursorTransportRequest): Promise<CursorTransportResponse> {
    validateRequest(request);
    const contentType = request.contentType ?? "application/connect+proto";
    const bridgeRequest: BridgePoolRequest = {
      accessToken: cleanAccessToken(request.accessToken),
      path: request.path,
      body: request.body,
      url: request.url === undefined ? this.url : validateOrigin(request.url),
      contentType,
      connectProtocolVersion: request.connectProtocolVersion
        ?? (contentType === "application/connect+proto" ? "1" : undefined),
      timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      machineId: this.machineId,
    };
    return this.pool.request(bridgeRequest, request.signal);
  }

  close(): void {
    this.pool.close();
  }
}

export async function collectTransportBody(
  response: CursorTransportResponse,
  maxBytes = MAX_BODY_BYTES,
): Promise<Uint8Array> {
  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative integer");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (result.value.byteLength > maxBytes - total) {
        const error = new RangeError(`Transport response exceeds the ${maxBytes} byte limit`);
        try {
          await reader.cancel(error);
        } catch {}
        throw error;
      }
      const copy = new Uint8Array(result.value);
      chunks.push(copy);
      total += copy.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
