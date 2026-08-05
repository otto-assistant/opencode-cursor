import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  CURSOR_SELECTION_HEADER,
  decodeCursorModelRequest,
  encodeCursorModelRequest,
  type CursorModelSelection,
} from "./model-selection.js";
import {
  isExplicitOneMillionContextSelection,
  resolveCursorModelSelection,
  type CursorModel,
} from "./models.js";
import {
  UNIFIED_CHAT_LIMITS,
  UNIFIED_CHAT_PATH,
  UnifiedChatResponseDecoder,
  encodeUnifiedChatRequest,
  type UnifiedChatEvent,
  type UnifiedChatImage,
  type UnifiedChatMessage,
  type UnifiedChatRequest,
  type UnifiedChatTool,
  type UnifiedChatToolCall,
} from "./unified-chat-protocol.js";
import type {
  CursorTransport,
  CursorTransportResponse,
} from "./unified-chat-transport.js";

export interface CursorFetchOptions {
  getAccessToken(): Promise<string>;
  getModels(): readonly CursorModel[];
  transport: CursorTransport;
}

interface ParsedChatRequest {
  stream: boolean;
  includeUsage: boolean;
  unified: UnifiedChatRequest;
}

interface CompletionState {
  text: string;
  reasoning: string;
  calls: UnifiedChatToolCall[];
  callsById: Map<string, UnifiedChatToolCall>;
  callIndexes: Map<number, string>;
  toolNames: ReadonlySet<string>;
}

interface EstimatedUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

type ToolChoice =
  | { type: "auto" }
  | { type: "none" };

class InvalidRequestError extends Error {
  constructor(message: string, readonly param: string | null = null) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

const textEncoder = new TextEncoder();
const strictTextDecoder = new TextDecoder("utf-8", { fatal: true });
const MAX_OPENAI_BODY_BYTES = 32 * 1024 * 1024;
const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const TOOL_CALL_METADATA_PREFIX = "oc_cursor_tool_call_v2_";
const LEGACY_TOOL_CALL_METADATA_PREFIX = "oc_cursor_model_call_v1_";
const TOOL_RESULT_CONTINUATION =
  "Continue from the tool result and follow the original request.";
const SSE_HEADERS = {
  "cache-control": "no-cache",
  "content-type": "text/event-stream; charset=utf-8",
  "x-content-type-options": "nosniff",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function requiredString(value: unknown, label: string, param: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidRequestError(`${label} must be a nonempty string`, param);
  }
  return value;
}

function mergeHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init?.headers !== undefined) {
    for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
  }
  return headers;
}

function prepareRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): { request: Request; selectionHeader: string | undefined; signal: AbortSignal | undefined } {
  const headers = mergeHeaders(input, init);
  const selectionHeader = headers.has(CURSOR_SELECTION_HEADER)
    ? headers.get(CURSOR_SELECTION_HEADER) ?? ""
    : undefined;
  headers.delete(CURSOR_SELECTION_HEADER);
  headers.delete("authorization");
  const signal = init && "signal" in init
    ? init.signal ?? undefined
    : input instanceof Request
      ? input.signal
      : undefined;
  const source = input instanceof Request ? input.clone() : input;
  return {
    request: new Request(source, { ...init, headers }),
    selectionHeader,
    signal,
  };
}

function resolveSelection(
  models: readonly CursorModel[],
  modelId: unknown,
  encodedSelection: string | undefined,
): CursorModelSelection {
  const requestedId = requiredString(modelId, "model", "model");
  let variant: string | undefined;
  if (encodedSelection !== undefined) {
    const decoded = decodeCursorModelRequest(encodedSelection);
    if (!decoded || encodeCursorModelRequest(decoded) !== encodedSelection) {
      throw new InvalidRequestError("Malformed Cursor model selection", "model");
    }
    if (decoded.modelId !== requestedId) {
      throw new InvalidRequestError(
        "Cursor model selection does not match the requested model",
        "model",
      );
    }
    variant = decoded.variant;
  }
  const selectedModel = models.find((model) => model.id === requestedId);
  const selection = resolveCursorModelSelection(models, requestedId, variant);
  if (!selection) throw new InvalidRequestError("Unknown Cursor model or variant", "model");

  const publicId = selection.publicId.toLowerCase();
  const serverId = selection.modelId.toLowerCase();
  const requested = requestedId.toLowerCase();
  if (
    requested === "default"
    || publicId === "default"
    || serverId === "default"
    || requested.startsWith("composer-")
    || publicId.startsWith("composer-")
    || serverId.startsWith("composer-")
  ) {
    throw new InvalidRequestError("This Cursor model is not supported by UnifiedChat", "model");
  }
  if (!/^(?:claude|gpt|gemini)(?:-|$)/.test(publicId)) {
    throw new InvalidRequestError("This Cursor model family is not supported by UnifiedChat", "model");
  }
  if (
    selection.maxMode &&
    (!selectedModel || !isExplicitOneMillionContextSelection(selectedModel, selection))
  ) {
    throw new InvalidRequestError("Cursor 1m context requires an explicit 1m model", "model");
  }
  return selection;
}

function parseTools(value: unknown): UnifiedChatTool[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new InvalidRequestError("tools must be an array", "tools");
  const names = new Set<string>();
  return value.map((rawTool, index) => {
    if (!isRecord(rawTool) || rawTool.type !== "function" || !isRecord(rawTool.function)) {
      throw new InvalidRequestError(`tools[${index}] must be an OpenAI function tool`, "tools");
    }
    const name = requiredString(rawTool.function.name, `tools[${index}].function.name`, "tools");
    if (names.has(name)) throw new InvalidRequestError(`Duplicate tool name at tools[${index}]`, "tools");
    names.add(name);
    if (rawTool.function.description !== undefined && typeof rawTool.function.description !== "string") {
      throw new InvalidRequestError(`tools[${index}].function.description must be a string`, "tools");
    }
    const parameters = rawTool.function.parameters ?? {};
    if (!isRecord(parameters)) {
      throw new InvalidRequestError(`tools[${index}].function.parameters must be an object`, "tools");
    }
    const tool: UnifiedChatTool = { name, parameters };
    if (typeof rawTool.function.description === "string") tool.description = rawTool.function.description;
    return tool;
  });
}

function parseToolChoice(value: unknown, tools: readonly UnifiedChatTool[]): ToolChoice {
  if (value === undefined || value === "auto") return { type: "auto" };
  if (value === "none") return { type: "none" };
  if (value === "required") {
    throw new InvalidRequestError("tool_choice required is not supported by Cursor UnifiedChat", "tool_choice");
  }
  if (
    !isRecord(value)
    || value.type !== "function"
    || !isRecord(value.function)
  ) {
    throw new InvalidRequestError("tool_choice must be auto, none, required, or a named function", "tool_choice");
  }
  requiredString(value.function.name, "tool_choice.function.name", "tool_choice");
  throw new InvalidRequestError("Named tool_choice is not supported by Cursor UnifiedChat", "tool_choice");
}

function selectedTools(tools: readonly UnifiedChatTool[], choice: ToolChoice): UnifiedChatTool[] {
  if (choice.type === "none") return [];
  return [...tools];
}

interface ImageBudget {
  count: number;
  bytes: number;
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.byteLength < 45 || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let dimensions: { width: number; height: number } | undefined;
  let sawData = false;
  while (offset + 12 <= bytes.byteLength) {
    const length = view.getUint32(offset, false);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const dataEnd = dataOffset + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataOffset || chunkEnd > bytes.byteLength) return undefined;
    const type = String.fromCharCode(...bytes.subarray(typeOffset, dataOffset));
    if (view.getUint32(dataEnd, false) !== crc32(bytes.subarray(typeOffset, dataEnd))) return undefined;
    if (!dimensions) {
      if (type !== "IHDR" || length !== 13) return undefined;
      dimensions = { width: view.getUint32(dataOffset, false), height: view.getUint32(dataOffset + 4, false) };
    } else if (type === "IDAT") {
      if (length > 0) sawData = true;
    } else if (type === "IEND") {
      return length === 0 && sawData && chunkEnd === bytes.byteLength ? dimensions : undefined;
    }
    offset = chunkEnd;
  }
  return undefined;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (
    bytes.byteLength < 8
    || bytes[0] !== 0xff
    || bytes[1] !== 0xd8
    || bytes[bytes.byteLength - 2] !== 0xff
    || bytes[bytes.byteLength - 1] !== 0xd9
  ) return undefined;
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let dimensions: { width: number; height: number } | undefined;
  let offset = 2;
  while (offset + 4 <= bytes.byteLength - 2) {
    while (offset < bytes.byteLength && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) return undefined;
    const marker = bytes[offset++];
    if (marker === 0xd9) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.byteLength) return undefined;
    const length = view.getUint16(offset, false);
    if (length < 2 || offset + length > bytes.byteLength) return undefined;
    if (marker === 0xda) {
      const scanOffset = offset + length;
      return length >= 6 && scanOffset < bytes.byteLength - 2 ? dimensions : undefined;
    }
    if (sof.has(marker)) {
      if (length < 7) return undefined;
      dimensions = {
        height: view.getUint16(offset + 3, false),
        width: view.getUint16(offset + 5, false),
      };
    }
    offset += length;
  }
  return undefined;
}

function gifDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.byteLength < 14) return undefined;
  const signature = String.fromCharCode(...bytes.subarray(0, 6));
  if (signature !== "GIF87a" && signature !== "GIF89a") return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dimensions = { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  const packed = bytes[10] ?? 0;
  let offset = 13 + ((packed & 0x80) !== 0 ? 3 * (2 ** ((packed & 0x07) + 1)) : 0);
  let sawImage = false;
  const skipSubBlocks = (): { ok: boolean; hadData: boolean } => {
    let hadData = false;
    while (offset < bytes.byteLength) {
      const length = bytes[offset++] ?? 0;
      if (length === 0) return { ok: true, hadData };
      hadData = true;
      if (offset + length > bytes.byteLength) return { ok: false, hadData };
      offset += length;
    }
    return { ok: false, hadData };
  };
  while (offset < bytes.byteLength) {
    const block = bytes[offset++];
    if (block === 0x3b) return sawImage && offset === bytes.byteLength ? dimensions : undefined;
    if (block === 0x21) {
      if (offset >= bytes.byteLength) return undefined;
      offset += 1;
      if (!skipSubBlocks().ok) return undefined;
      continue;
    }
    if (block !== 0x2c || offset + 9 > bytes.byteLength) return undefined;
    const localPacked = bytes[offset + 8] ?? 0;
    offset += 9;
    if ((localPacked & 0x80) !== 0) offset += 3 * (2 ** ((localPacked & 0x07) + 1));
    if (offset >= bytes.byteLength) return undefined;
    offset += 1;
    const imageData = skipSubBlocks();
    if (!imageData.ok || !imageData.hadData) return undefined;
    sawImage = true;
  }
  return undefined;
}

function uint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (
    bytes.byteLength < 20
    || String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF"
    || String.fromCharCode(...bytes.subarray(8, 12)) !== "WEBP"
  ) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.byteLength) return undefined;
  let offset = 12;
  let dimensions: { width: number; height: number } | undefined;
  let sawImage = false;
  while (offset + 8 <= bytes.byteLength) {
    const type = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    if (payload + size > bytes.byteLength) return undefined;
    if (type === "VP8X" && size >= 10) {
      dimensions = {
        width: uint24LittleEndian(bytes, payload + 4) + 1,
        height: uint24LittleEndian(bytes, payload + 7) + 1,
      };
    } else if (type === "VP8 " && size >= 10 && bytes[payload + 3] === 0x9d && bytes[payload + 4] === 0x01 && bytes[payload + 5] === 0x2a) {
      dimensions ??= {
        width: view.getUint16(payload + 6, true) & 0x3fff,
        height: view.getUint16(payload + 8, true) & 0x3fff,
      };
      sawImage = true;
    } else if (type === "VP8L" && size >= 5 && bytes[payload] === 0x2f) {
      const bits = view.getUint32(payload + 1, true);
      dimensions ??= {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
      sawImage = true;
    } else if (type === "ANMF") {
      if (size < 24) return undefined;
      let nestedOffset = payload + 16;
      const nestedEnd = payload + size;
      let nestedImage = false;
      while (nestedOffset + 8 <= nestedEnd) {
        const nestedType = String.fromCharCode(...bytes.subarray(nestedOffset, nestedOffset + 4));
        const nestedSize = view.getUint32(nestedOffset + 4, true);
        const nestedPayload = nestedOffset + 8;
        if (nestedPayload + nestedSize > nestedEnd) return undefined;
        if (
          nestedType === "VP8 "
          && nestedSize >= 10
          && bytes[nestedPayload + 3] === 0x9d
          && bytes[nestedPayload + 4] === 0x01
          && bytes[nestedPayload + 5] === 0x2a
        ) nestedImage = true;
        if (nestedType === "VP8L" && nestedSize >= 5 && bytes[nestedPayload] === 0x2f) nestedImage = true;
        nestedOffset = nestedPayload + nestedSize + (nestedSize % 2);
      }
      if (!nestedImage || nestedOffset !== nestedEnd) return undefined;
      sawImage = true;
    }
    offset = payload + size + (size % 2);
  }
  return offset === bytes.byteLength && sawImage ? dimensions : undefined;
}

function parseImageDataUrl(value: unknown, budget: ImageBudget): UnifiedChatImage {
  if (typeof value !== "string") throw new InvalidRequestError("image_url.url must be a string", "messages");
  if (!value.startsWith("data:")) {
    throw new InvalidRequestError("Remote image URLs are not supported", "messages");
  }
  const match = /^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match?.[1] || !match[2]) {
    throw new InvalidRequestError("Only canonical base64 PNG, JPEG, GIF, or WebP data URLs are supported", "messages");
  }
  const mime = match[1].toLowerCase();
  const encoded = match[2];
  if (encoded.length % 4 !== 0) {
    throw new InvalidRequestError("Image base64 is malformed", "messages");
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const decodedLength = (encoded.length / 4) * 3 - padding;
  if (decodedLength > UNIFIED_CHAT_LIMITS.maxImageBytes) {
    throw new InvalidRequestError("Image exceeds the per-image limit", "messages");
  }
  if (budget.count >= UNIFIED_CHAT_LIMITS.maxImages) {
    throw new InvalidRequestError("Request contains too many images", "messages");
  }
  if (decodedLength > UNIFIED_CHAT_LIMITS.maxTotalImageBytes - budget.bytes) {
    throw new InvalidRequestError("Image total exceeds the request limit", "messages");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) {
    throw new InvalidRequestError("Image base64 is noncanonical", "messages");
  }
  const dimensions = mime === "image/png"
    ? pngDimensions(decoded)
    : mime === "image/jpeg" || mime === "image/jpg"
      ? jpegDimensions(decoded)
      : mime === "image/gif"
        ? gifDimensions(decoded)
        : webpDimensions(decoded);
  if (!dimensions) throw new InvalidRequestError("Image structure or dimensions are invalid", "messages");
  const { width, height } = dimensions;
  if (
    width === 0
    || height === 0
    || width > UNIFIED_CHAT_LIMITS.maxImageDimension
    || height > UNIFIED_CHAT_LIMITS.maxImageDimension
  ) {
    throw new InvalidRequestError("Image dimensions are invalid", "messages");
  }
  budget.count += 1;
  budget.bytes += decoded.byteLength;
  return { data: decoded, width, height };
}

function parseUserContent(
  value: unknown,
  imageBudget: ImageBudget,
): { text: string; images: UnifiedChatImage[] } {
  if (typeof value === "string") return { text: value, images: [] };
  if (!Array.isArray(value)) {
    throw new InvalidRequestError("User message content must be a string or content array", "messages");
  }
  const text: string[] = [];
  const images: UnifiedChatImage[] = [];
  for (const [index, rawPart] of value.entries()) {
    if (!isRecord(rawPart) || typeof rawPart.type !== "string") {
      throw new InvalidRequestError(`messages content part ${index} is malformed`, "messages");
    }
    if (rawPart.type === "text") {
      if (typeof rawPart.text !== "string") {
        throw new InvalidRequestError(`messages content part ${index} text must be a string`, "messages");
      }
      text.push(rawPart.text);
      continue;
    }
    if (rawPart.type === "image_url") {
      if (!isRecord(rawPart.image_url)) {
        throw new InvalidRequestError(`messages content part ${index} image_url is malformed`, "messages");
      }
      images.push(parseImageDataUrl(rawPart.image_url.url, imageBudget));
      continue;
    }
    throw new InvalidRequestError(`Unsupported messages content part type: ${rawPart.type}`, "messages");
  }
  return { text: text.join("\n"), images };
}

function parseAssistantText(value: unknown, hasCalls: boolean): string {
  if (typeof value === "string") return value;
  if ((value === null || value === undefined) && hasCalls) return "";
  throw new InvalidRequestError("Assistant message content must be text", "messages");
}

interface HistoricalToolCall {
  externalId: string;
  call: UnifiedChatToolCall;
}

function decodeToolCallId(value: string): {
  id: string;
  modelCallId?: string;
  serverName?: string;
  wireName?: string;
} {
  const legacy = value.startsWith(LEGACY_TOOL_CALL_METADATA_PREFIX);
  const prefix = value.startsWith(TOOL_CALL_METADATA_PREFIX)
    ? TOOL_CALL_METADATA_PREFIX
    : legacy
      ? LEGACY_TOOL_CALL_METADATA_PREFIX
      : undefined;
  if (!prefix) return { id: value };
  const encoded = value.slice(prefix.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new InvalidRequestError("Tool call id metadata is malformed", "messages");
  }
  if (!isRecord(parsed) || typeof parsed.id !== "string" || !parsed.id) {
    throw new InvalidRequestError("Tool call id metadata is malformed", "messages");
  }
  if (legacy) {
    if (typeof parsed.modelCallId !== "string" || parsed.modelCallId.length === 0) {
      throw new InvalidRequestError("Tool call id metadata is malformed", "messages");
    }
    const metadata = { id: parsed.id, modelCallId: parsed.modelCallId };
    const canonical = Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
    if (canonical !== encoded) {
      throw new InvalidRequestError("Tool call id metadata is malformed", "messages");
    }
    return metadata;
  }
  for (const key of ["modelCallId", "serverName", "wireName"] as const) {
    if (parsed[key] !== undefined && (typeof parsed[key] !== "string" || parsed[key].length === 0)) {
      throw new InvalidRequestError("Tool call id metadata is malformed", "messages");
    }
  }
  const metadata = {
    id: parsed.id,
    ...(typeof parsed.modelCallId === "string" ? { modelCallId: parsed.modelCallId } : {}),
    ...(typeof parsed.serverName === "string" ? { serverName: parsed.serverName } : {}),
    ...(typeof parsed.wireName === "string" ? { wireName: parsed.wireName } : {}),
  };
  const canonical = Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
  if (canonical !== encoded) throw new InvalidRequestError("Tool call id metadata is malformed", "messages");
  return metadata;
}

function parseToolCalls(
  value: unknown,
  seenCallIds: Set<string>,
): HistoricalToolCall[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidRequestError("assistant.tool_calls must be a nonempty array", "messages");
  }
  return value.map((rawCall, index) => {
    if (!isRecord(rawCall) || rawCall.type !== "function" || !isRecord(rawCall.function)) {
      throw new InvalidRequestError(`assistant.tool_calls[${index}] is malformed`, "messages");
    }
    const externalId = requiredString(rawCall.id, `assistant.tool_calls[${index}].id`, "messages");
    if (seenCallIds.has(externalId)) throw new InvalidRequestError("Duplicate tool call id", "messages");
    seenCallIds.add(externalId);
    const decodedId = decodeToolCallId(externalId);
    const name = requiredString(rawCall.function.name, `assistant.tool_calls[${index}].function.name`, "messages");
    if (
      decodedId.serverName
      && decodedId.serverName !== "opencode"
      && decodedId.serverName !== "unknown"
      && decodedId.serverName !== name
    ) {
      throw new InvalidRequestError("Tool call id metadata has an invalid server namespace", "messages");
    }
    if (typeof rawCall.function.arguments !== "string") {
      throw new InvalidRequestError("Tool call arguments must be a JSON string", "messages");
    }
    return {
      externalId,
      call: {
        id: decodedId.id,
        name,
        index,
        arguments: rawCall.function.arguments,
        ...(decodedId.modelCallId ? { modelCallId: decodedId.modelCallId } : {}),
        ...(decodedId.serverName ? { serverName: decodedId.serverName } : {}),
        ...(decodedId.wireName ? { wireName: decodedId.wireName } : {}),
      },
    };
  });
}

function parseMessages(value: unknown, tools: readonly UnifiedChatTool[]): {
  system: string;
  messages: UnifiedChatMessage[];
} {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidRequestError("messages must be a nonempty array", "messages");
  }
  const system: string[] = [];
  const messages: UnifiedChatMessage[] = [];
  const seenCallIds = new Set<string>();
  const imageBudget: ImageBudget = { count: 0, bytes: 0 };

  for (let index = 0; index < value.length; index += 1) {
    const rawMessage = value[index];
    if (!isRecord(rawMessage) || typeof rawMessage.role !== "string") {
      throw new InvalidRequestError(`messages[${index}] is malformed`, "messages");
    }
    if (rawMessage.role === "system" || rawMessage.role === "developer") {
      if (typeof rawMessage.content !== "string") {
        throw new InvalidRequestError(`${rawMessage.role} message content must be a string`, "messages");
      }
      system.push(rawMessage.content);
      continue;
    }
    if (rawMessage.role === "user") {
      const content = parseUserContent(rawMessage.content, imageBudget);
      const message: UnifiedChatMessage = { role: "user", text: content.text };
      if (content.images.length > 0) message.images = content.images;
      messages.push(message);
      continue;
    }
    if (rawMessage.role === "tool") {
      throw new InvalidRequestError("Tool result message has no preceding assistant tool-call group", "messages");
    }
    if (rawMessage.role !== "assistant") {
      throw new InvalidRequestError(`Unsupported message role: ${rawMessage.role}`, "messages");
    }

    const hasCalls = rawMessage.tool_calls !== undefined;
    const assistantText = parseAssistantText(rawMessage.content, hasCalls);
    if (!hasCalls) {
      messages.push({ role: "assistant", text: assistantText });
      continue;
    }

    const calls = parseToolCalls(rawMessage.tool_calls, seenCallIds);
    const callsById = new Map(calls.map((entry) => [entry.externalId, entry.call]));
    const results = new Map<string, string>();
    let resultIndex = index + 1;
    while (resultIndex < value.length) {
      const rawResult = value[resultIndex];
      if (!isRecord(rawResult) || rawResult.role !== "tool") break;
      const callId = requiredString(rawResult.tool_call_id, "tool.tool_call_id", "messages");
      if (!callsById.has(callId)) throw new InvalidRequestError("Tool result references an unknown call", "messages");
      if (results.has(callId)) throw new InvalidRequestError("Duplicate tool result", "messages");
      if (typeof rawResult.content !== "string") {
        throw new InvalidRequestError("Tool result content must be a string", "messages");
      }
      results.set(callId, rawResult.content);
      resultIndex += 1;
    }
    if (results.size !== calls.length) throw new InvalidRequestError("Assistant tool-call group is missing results", "messages");
    messages.push({
      role: "assistant",
      text: assistantText,
      toolResults: calls.map(({ externalId, call }) => ({
        call,
        result: results.get(externalId) ?? "",
      })),
    });
    messages.push({ role: "user", text: TOOL_RESULT_CONTINUATION });
    index = resultIndex - 1;
  }

  if (messages.length === 0) {
    throw new InvalidRequestError("messages must include at least one user or assistant message", "messages");
  }
  return { system: system.join("\n"), messages };
}

function parseIncludeUsage(value: unknown): boolean {
  if (value === undefined) return false;
  if (!isRecord(value)) throw new InvalidRequestError("stream_options must be an object", "stream_options");
  if (value.include_usage !== undefined && typeof value.include_usage !== "boolean") {
    throw new InvalidRequestError("stream_options.include_usage must be a boolean", "stream_options");
  }
  return value.include_usage === true;
}

function parseChatRequest(
  value: unknown,
  models: readonly CursorModel[],
  selectionHeader: string | undefined,
): ParsedChatRequest {
  if (!isRecord(value)) throw new InvalidRequestError("Request body must be a JSON object");
  if (value.stream !== undefined && typeof value.stream !== "boolean") {
    throw new InvalidRequestError("stream must be a boolean", "stream");
  }
  const selection = resolveSelection(models, value.model, selectionHeader);
  const tools = parseTools(value.tools);
  const choice = parseToolChoice(value.tool_choice, tools);
  const parsedMessages = parseMessages(value.messages, tools);
  return {
    stream: value.stream ?? false,
    includeUsage: parseIncludeUsage(value.stream_options),
    unified: {
      system: parsedMessages.system,
      messages: parsedMessages.messages,
      tools: selectedTools(tools, choice),
      model: selection.publicId,
      maxMode: selection.maxMode,
    },
  };
}

function errorEnvelope(
  message: string,
  type: string,
  code: string,
  param: string | null = null,
): { error: { message: string; type: string; param: string | null; code: string } } {
  return { error: { message, type, param, code } };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function invalidResponse(error: InvalidRequestError): Response {
  return jsonResponse(errorEnvelope(
    error.message,
    "invalid_request_error",
    "invalid_request_error",
    error.param,
  ), 400);
}

function safeHttpStatus(status: number): number {
  return Number.isInteger(status) && status >= 300 && status <= 599 ? status : 502;
}

function httpErrorResponse(status: number): Response {
  const safeStatus = safeHttpStatus(status);
  if (safeStatus === 401 || safeStatus === 403) {
    return jsonResponse(errorEnvelope(
      "Cursor authentication was rejected",
      "authentication_error",
      "cursor_authentication_error",
    ), safeStatus);
  }
  if (safeStatus === 429) {
    return jsonResponse(errorEnvelope(
      "Cursor request was rate limited",
      "rate_limit_error",
      "cursor_rate_limit_error",
    ), safeStatus);
  }
  return jsonResponse(errorEnvelope(
    safeStatus >= 500 ? "Cursor service request failed" : "Cursor request was rejected",
    "api_error",
    "cursor_upstream_error",
  ), safeStatus);
}

function connectStatus(code: string): number {
  switch (code.toLowerCase()) {
    case "invalid_argument": return 400;
    case "unauthenticated": return 401;
    case "permission_denied": return 403;
    case "not_found": return 404;
    case "resource_exhausted": return 429;
    case "deadline_exceeded": return 504;
    case "unavailable": return 503;
    default: return 502;
  }
}

function connectErrorResponse(code: string): Response {
  return jsonResponse(errorEnvelope(
    "Cursor response could not be completed",
    "api_error",
    "cursor_protocol_error",
  ), connectStatus(code));
}

function transportErrorResponse(error?: unknown): Response {
  const timedOut = error instanceof Error && error.name === "TimeoutError";
  return jsonResponse(errorEnvelope(
    timedOut ? "Cursor transport request timed out" : "Cursor transport request failed",
    "api_error",
    timedOut ? "cursor_timeout" : "cursor_transport_error",
  ), timedOut ? 504 : 502);
}

async function readRequestText(request: Request): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_OPENAI_BODY_BYTES) {
      throw new InvalidRequestError("Request body exceeds the 32 MiB limit");
    }
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (result.value.byteLength > MAX_OPENAI_BODY_BYTES - total) {
        await reader.cancel().catch(() => undefined);
        throw new InvalidRequestError("Request body exceeds the 32 MiB limit");
      }
      chunks.push(result.value);
      total += result.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return strictTextDecoder.decode(bytes);
  } catch {
    throw new InvalidRequestError("Request body must be UTF-8 JSON");
  }
}

function estimateUtf8(strings: readonly string[]): number {
  const bytes = strings.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0);
  return Math.ceil(bytes / 4);
}

/** Local monotonic estimate only; these values are not Cursor billing usage. */
function estimatePromptTokens(request: UnifiedChatRequest): number {
  const text: string[] = [request.system, request.model];
  let imageTokens = 0;
  for (const message of request.messages) {
    text.push(message.text ?? "");
    for (const image of message.images ?? []) {
      imageTokens += Math.ceil((image.width * image.height) / 4_096);
    }
    for (const result of message.toolResults ?? []) {
      text.push(
        result.call.id,
        result.call.name,
        result.call.arguments,
        result.call.modelCallId ?? "",
        result.result,
      );
    }
  }
  for (const tool of request.tools ?? []) {
    text.push(tool.name, tool.description ?? "", JSON.stringify(tool.parameters));
  }
  return estimateUtf8(text) + imageTokens;
}

function estimateUsage(promptTokens: number, state: CompletionState): EstimatedUsage {
  const completionTokens = estimateUtf8([
    state.text,
    state.reasoning,
    ...state.calls.flatMap((call) => [call.id, call.name, call.arguments]),
  ]);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function createCompletionState(tools: readonly UnifiedChatTool[]): CompletionState {
  return {
    text: "",
    reasoning: "",
    calls: [],
    callsById: new Map(),
    callIndexes: new Map(),
    toolNames: new Set(tools.map((tool) => tool.name)),
  };
}

function sameCall(left: UnifiedChatToolCall, right: UnifiedChatToolCall): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.index === right.index
    && left.arguments === right.arguments
    && left.modelCallId === right.modelCallId
    && left.serverName === right.serverName
    && left.wireName === right.wireName;
}

function addCall(state: CompletionState, call: UnifiedChatToolCall): "added" | "duplicate" | "conflict" {
  if (!state.toolNames.has(call.name)) return "conflict";
  const existing = state.callsById.get(call.id);
  if (existing) return sameCall(existing, call) ? "duplicate" : "conflict";
  const indexedId = state.callIndexes.get(call.index);
  if (indexedId && indexedId !== call.id) return "conflict";
  state.calls.push(call);
  state.callsById.set(call.id, call);
  state.callIndexes.set(call.index, call.id);
  return "added";
}

function applyEvent(state: CompletionState, event: UnifiedChatEvent): string | undefined {
  if (event.type === "text") state.text += event.text;
  else if (event.type === "reasoning") state.reasoning += event.text;
  else if (event.type === "tool-call" && addCall(state, event.call) === "conflict") return "protocol_error";
  else if (event.type === "error") return event.code;
  return undefined;
}

function openAiToolCall(call: UnifiedChatToolCall): Record<string, unknown> {
  const metadata = {
    id: call.id,
    ...(call.modelCallId ? { modelCallId: call.modelCallId } : {}),
    ...(call.serverName ? { serverName: call.serverName } : {}),
    ...(call.wireName ? { wireName: call.wireName } : {}),
  };
  const id = `${TOOL_CALL_METADATA_PREFIX}${Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url")}`;
  return {
    id,
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  };
}

async function cancelBody(response: CursorTransportResponse): Promise<void> {
  try {
    await response.body.cancel();
  } catch {}
}

async function nonStreamingResponse(
  response: CursorTransportResponse,
  request: UnifiedChatRequest,
  promptTokens: number,
): Promise<Response> {
  const reader = response.body.getReader();
  const decoder = new UnifiedChatResponseDecoder();
  const state = createCompletionState(request.tools ?? []);
  let protocolCode: string | undefined;
  try {
    while (!protocolCode) {
      const result = await reader.read();
      if (result.done) break;
      for (const event of decoder.push(result.value)) {
        protocolCode = applyEvent(state, event) ?? protocolCode;
      }
    }
    if (!protocolCode) {
      for (const event of decoder.finish()) protocolCode = applyEvent(state, event) ?? protocolCode;
    }
    if (protocolCode) {
      try {
        await reader.cancel();
      } catch {}
      return connectErrorResponse(protocolCode);
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    try {
      await reader.cancel();
    } catch {}
    return transportErrorResponse(error);
  } finally {
    reader.releaseLock();
  }

  state.calls.sort((left, right) => left.index - right.index);
  const message: Record<string, unknown> = { role: "assistant", content: state.text };
  if (state.reasoning) message.reasoning_content = state.reasoning;
  if (state.calls.length > 0) message.tool_calls = state.calls.map(openAiToolCall);
  return jsonResponse({
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1_000),
    model: request.model,
    choices: [{
      index: 0,
      message,
      finish_reason: state.calls.length > 0 ? "tool_calls" : "stop",
    }],
    usage: estimateUsage(promptTokens, state),
  });
}

function streamChunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: "stop" | "tool_calls" | null,
): Record<string, unknown> {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function sseData(value: unknown): Uint8Array {
  return textEncoder.encode(`data: ${JSON.stringify(value)}\n\n`);
}

function streamingResponse(
  response: CursorTransportResponse,
  request: UnifiedChatRequest,
  promptTokens: number,
  includeUsage: boolean,
): Response {
  const reader = response.body.getReader();
  const decoder = new UnifiedChatResponseDecoder();
  const state = createCompletionState(request.tools ?? []);
  const model = request.model;
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1_000);
  const pending: Uint8Array[] = [];
  let terminal = false;
  let roleSent = false;
  let released = false;

  const release = (): void => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  const deltaWithRole = (delta: Record<string, unknown>): Record<string, unknown> => {
    if (roleSent) return delta;
    roleSent = true;
    return { role: "assistant", ...delta };
  };
  const finishSuccessfully = (): void => {
    if (terminal) return;
    const finishReason = state.calls.length > 0 ? "tool_calls" : "stop";
    pending.push(sseData(streamChunk(id, created, model, {}, finishReason)));
    if (includeUsage) {
      pending.push(sseData({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [],
        usage: estimateUsage(promptTokens, state),
      }));
    }
    pending.push(textEncoder.encode("data: [DONE]\n\n"));
    terminal = true;
  };
  const failSafely = (): void => {
    if (terminal) return;
    pending.push(sseData(errorEnvelope(
      "Cursor response stream failed",
      "api_error",
      "cursor_protocol_error",
    )));
    pending.push(textEncoder.encode("data: [DONE]\n\n"));
    terminal = true;
  };
  const processEvents = (events: readonly UnifiedChatEvent[]): boolean => {
    for (const event of events) {
      if (event.type === "text") {
        state.text += event.text;
        pending.push(sseData(streamChunk(
          id,
          created,
          model,
          deltaWithRole({ content: event.text }),
          null,
        )));
      } else if (event.type === "reasoning") {
        state.reasoning += event.text;
        pending.push(sseData(streamChunk(
          id,
          created,
          model,
          deltaWithRole({ reasoning_content: event.text }),
          null,
        )));
      } else if (event.type === "tool-call") {
        const result = addCall(state, event.call);
        if (result === "conflict") {
          failSafely();
          return false;
        }
        if (result === "added") {
          pending.push(sseData(streamChunk(id, created, model, deltaWithRole({
            tool_calls: [{ index: event.call.index, ...openAiToolCall(event.call) }],
          }), null)));
        }
      } else if (event.type === "error") {
        failSafely();
        return false;
      } else if (event.type === "end") {
        finishSuccessfully();
      }
    }
    return true;
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (pending.length === 0 && !terminal) {
        try {
          const result = await reader.read();
          if (result.done) {
            processEvents(decoder.finish());
            release();
            break;
          }
          if (!processEvents(decoder.push(result.value))) {
            try {
              await reader.cancel();
            } catch {}
            release();
          }
        } catch (error) {
          if (isAbortError(error)) {
            terminal = true;
            release();
            controller.error(error);
            return;
          }
          failSafely();
          try {
            await reader.cancel();
          } catch {}
          release();
        }
      }
      const next = pending.shift();
      if (next) controller.enqueue(next);
      else if (terminal) controller.close();
    },
    async cancel(reason: unknown) {
      terminal = true;
      pending.length = 0;
      try {
        if (!released) await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

/**
 * Creates an in-process OpenAI chat-completions fetch adapter for stateless
 * Cursor UnifiedChat requests. Returned usage is a local estimate, not Cursor
 * billing usage.
 */
export function createCursorFetch(
  options: CursorFetchOptions,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    let prepared: ReturnType<typeof prepareRequest>;
    try {
      prepared = prepareRequest(input, init);
    } catch (error) {
      if (isAbortError(error)) throw error;
      return invalidResponse(new InvalidRequestError("Invalid fetch request"));
    }

    if (prepared.request.method !== "POST") {
      return invalidResponse(new InvalidRequestError("Only POST is supported"));
    }
    if (!prepared.request.url || !new URL(prepared.request.url).pathname.endsWith("/chat/completions")) {
      return invalidResponse(new InvalidRequestError("Only /chat/completions is supported"));
    }

    let bodyValue: unknown;
    try {
      const bodyText = await readRequestText(prepared.request);
      if (!bodyText) throw new InvalidRequestError("Request body is required");
      bodyValue = JSON.parse(bodyText) as unknown;
    } catch (error) {
      if (isAbortError(error)) throw error;
      return invalidResponse(error instanceof InvalidRequestError
        ? error
        : new InvalidRequestError("Request body must be valid JSON"));
    }

    let parsed: ParsedChatRequest;
    let encoded: Uint8Array;
    try {
      parsed = parseChatRequest(bodyValue, options.getModels(), prepared.selectionHeader);
      encoded = encodeUnifiedChatRequest(parsed.unified);
    } catch (error) {
      if (error instanceof InvalidRequestError) return invalidResponse(error);
      if (error instanceof TypeError || error instanceof RangeError) {
        return invalidResponse(new InvalidRequestError(error.message));
      }
      return transportErrorResponse(error);
    }

    let accessToken: string;
    try {
      accessToken = await options.getAccessToken();
    } catch (error) {
      if (isAbortError(error)) throw error;
      return jsonResponse(errorEnvelope(
        "Cursor authentication is unavailable",
        "authentication_error",
        "cursor_authentication_error",
      ), 401);
    }

    let response: CursorTransportResponse;
    try {
      response = await options.transport.request({
        accessToken,
        path: UNIFIED_CHAT_PATH,
        body: encoded,
        signal: prepared.signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      return transportErrorResponse(error);
    }
    void response.trailers.catch(() => {});
    if (response.status < 200 || response.status >= 300) {
      await cancelBody(response);
      return httpErrorResponse(response.status);
    }

    const promptTokens = estimatePromptTokens(parsed.unified);
    return parsed.stream
      ? streamingResponse(response, parsed.unified, promptTokens, parsed.includeUsage)
      : nonStreamingResponse(response, parsed.unified, promptTokens);
  };
}
