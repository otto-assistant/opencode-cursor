import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

export const UNIFIED_CHAT_PATH = "/aiserver.v1.ChatService/StreamUnifiedChatWithTools";

export const UNIFIED_CHAT_LIMITS = Object.freeze({
  maxFrameBytes: 32 * 1024 * 1024,
  maxMessages: 128,
  maxTools: 128,
  maxToolSchemaBytes: 1024 * 1024,
  maxToolSchemaTotalBytes: 4 * 1024 * 1024,
  maxToolArgumentsBytes: 1024 * 1024,
  maxToolResultBytes: 8 * 1024 * 1024,
  maxToolReplayBytes: 8 * 1024 * 1024,
  maxEncodedToolReplayBytes: 8 * 1024 * 1024,
  maxImages: 4,
  maxImageBytes: 8 * 1024 * 1024,
  maxTotalImageBytes: 20 * 1024 * 1024,
  maxImageDimension: 65_535,
  maxResponseBytes: 32 * 1024 * 1024,
} as const);

export interface UnifiedChatImage {
  data: Uint8Array;
  width: number;
  height: number;
  uuid?: string;
}

export interface UnifiedChatTool {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface UnifiedChatToolCall {
  id: string;
  name: string;
  index: number;
  arguments: string;
  modelCallId?: string;
  serverName?: string;
  wireName?: string;
}

export interface UnifiedChatToolResult {
  call: UnifiedChatToolCall;
  result: string;
}

export interface UnifiedChatMessage {
  role: "user" | "assistant";
  text?: string;
  images?: readonly UnifiedChatImage[];
  toolResults?: readonly UnifiedChatToolResult[];
}

export interface UnifiedChatRequest {
  system: string;
  messages: readonly UnifiedChatMessage[];
  tools?: readonly UnifiedChatTool[];
  model: string;
  maxMode?: boolean;
}

export type UnifiedChatEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; call: UnifiedChatToolCall }
  | { type: "metadata" }
  | { type: "error"; code: string; message: string; retryable: boolean }
  | { type: "end" };

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

const textEncoder = new TextEncoder();
const strictTextDecoder = new TextDecoder("utf-8", { fatal: true });
const SERVER_NAME = "opencode";
const CALL_MCP_TOOL = 49;
const MODE_CHAT = 1;
const MODE_AGENT = 2;
const MAX_PROTO_DEPTH = 64;
const MAX_PROTO_FIELDS = 100_000;
const MAX_JSON_NODES = 20_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class ProtoWriter {
  readonly chunks: Uint8Array[] = [];
  byteLength = 0;

  private append(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.chunks.push(bytes);
    this.byteLength += bytes.byteLength;
  }

  private header(fieldNumber: number, wireType: number): void {
    this.append(encodeVarint((BigInt(fieldNumber) << 3n) | BigInt(wireType)));
  }

  appendMessage(writer: ProtoWriter): void {
    for (const chunk of writer.chunks) this.append(chunk);
  }

  finish(): Uint8Array {
    const output = new Uint8Array(this.byteLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }

  varint(fieldNumber: number, value: number | bigint): void {
    this.header(fieldNumber, 0);
    this.append(encodeVarint(value));
  }

  bytes(fieldNumber: number, value: string | Uint8Array): void {
    const bytes = typeof value === "string" ? textEncoder.encode(value) : value;
    this.header(fieldNumber, 2);
    this.append(encodeVarint(bytes.byteLength));
    this.append(bytes);
  }

  message(fieldNumber: number, write: (writer: ProtoWriter) => void): void {
    const nested = new ProtoWriter();
    write(nested);
    this.header(fieldNumber, 2);
    this.append(encodeVarint(nested.byteLength));
    for (const chunk of nested.chunks) this.append(chunk);
  }

  packedVarints(fieldNumber: number, values: readonly number[]): void {
    this.message(fieldNumber, (writer) => {
      for (const value of values) writer.append(encodeVarint(value));
    });
  }

  double(fieldNumber: number, value: number): void {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    this.header(fieldNumber, 1);
    this.append(bytes);
  }
}

function encodeVarint(input: number | bigint): Uint8Array {
  let value = BigInt(input);
  if (value < 0n) value = BigInt.asUintN(64, value);
  const bytes: number[] = [];
  do {
    let byte = Number(value & 0x7fn);
    value >>= 7n;
    if (value !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0n);
  return Uint8Array.from(bytes);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(value: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) ? parsed as JsonObject : undefined;
  } catch {
    return undefined;
  }
}

function normalizeJsonObject(value: unknown, label: string): { object: JsonObject; json: string; bytes: number } {
  if (!isObject(value)) throw new TypeError(`${label} must be a JSON object`);
  let json: string;
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string") throw new TypeError();
    json = encoded;
  } catch {
    throw new TypeError(`${label} must be JSON-serializable`);
  }
  const object = parseJsonObject(json);
  if (!object) throw new TypeError(`${label} must be a JSON object`);
  validateJsonComplexity(object, label);
  return { object, json, bytes: Buffer.byteLength(json, "utf8") };
}

function validateJsonComplexity(value: JsonValue, label: string): void {
  let nodes = 0;
  const visit = (item: JsonValue, depth: number): void => {
    if (depth > MAX_PROTO_DEPTH) throw new RangeError(`${label} nesting exceeds limit`);
    nodes += 1;
    if (nodes > MAX_JSON_NODES) throw new RangeError(`${label} complexity exceeds limit`);
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
    } else if (item !== null && typeof item === "object") {
      for (const child of Object.values(item)) visit(child, depth + 1);
    }
  };
  visit(value, 0);
}

function varintByteLength(input: number | bigint): number {
  let value = BigInt(input);
  if (value < 0n) value = BigInt.asUintN(64, value);
  let length = 1;
  while (value >= 0x80n) {
    value >>= 7n;
    length += 1;
  }
  return length;
}

function tagByteLength(fieldNumber: number, wireType: number): number {
  return varintByteLength((BigInt(fieldNumber) << 3n) | BigInt(wireType));
}

function encodedVarintFieldSize(fieldNumber: number, value: number | bigint): number {
  return tagByteLength(fieldNumber, 0) + varintByteLength(value);
}

function encodedBytesFieldSize(fieldNumber: number, byteLength: number): number {
  return tagByteLength(fieldNumber, 2) + varintByteLength(byteLength) + byteLength;
}

function encodedStringFieldSize(fieldNumber: number, value: string): number {
  return encodedBytesFieldSize(fieldNumber, Buffer.byteLength(value, "utf8"));
}

function encodedMessageFieldSize(fieldNumber: number, contentSize: number): number {
  return encodedBytesFieldSize(fieldNumber, contentSize);
}

function encodedProtoValueSize(value: JsonValue, depth: number): number {
  if (depth > MAX_PROTO_DEPTH) throw new RangeError("JSON value nesting exceeds limit");
  if (value === null) return encodedVarintFieldSize(1, 0);
  if (typeof value === "number") return tagByteLength(2, 1) + 8;
  if (typeof value === "string") return encodedStringFieldSize(3, value);
  if (typeof value === "boolean") return encodedVarintFieldSize(4, value ? 1 : 0);
  if (Array.isArray(value)) {
    let listSize = 0;
    for (const item of value) {
      listSize += encodedMessageFieldSize(1, encodedProtoValueSize(item, depth + 1));
    }
    return encodedMessageFieldSize(6, listSize);
  }
  return encodedMessageFieldSize(5, encodedProtoStructSize(value, depth));
}

function encodedProtoStructSize(value: JsonObject, depth = 0): number {
  if (depth > MAX_PROTO_DEPTH) throw new RangeError("JSON value nesting exceeds limit");
  return Object.entries(value).reduce((total, [key, item]) => {
    const entrySize = encodedStringFieldSize(1, key)
      + encodedMessageFieldSize(2, encodedProtoValueSize(item, depth + 1));
    return total + encodedMessageFieldSize(1, entrySize);
  }, 0);
}

function requireNonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a nonempty string`);
  }
}

interface NormalizedTool extends UnifiedChatTool {
  description: string;
  schema: JsonObject;
  schemaJson: string;
}

interface NormalizedToolResult {
  call: UnifiedChatToolCall;
  argumentsObject: JsonObject;
  result: string;
}

interface NormalizedMessage {
  role: "user" | "assistant";
  text: string;
  images: readonly UnifiedChatImage[];
  toolResults: readonly NormalizedToolResult[];
  bubbleId: string;
  serverBubbleId?: string;
}

function encodedCallParamsSize(result: NormalizedToolResult): number {
  return encodedStringFieldSize(1, result.call.serverName ?? SERVER_NAME)
    + encodedStringFieldSize(2, result.call.name)
    + encodedMessageFieldSize(3, encodedProtoStructSize(result.argumentsObject));
}

function encodedResultParamsSize(result: NormalizedToolResult): number {
  const value: JsonObject = {
    content: [{ type: "text", text: result.result }],
    isError: false,
  };
  return encodedStringFieldSize(1, result.call.serverName ?? SERVER_NAME)
    + encodedStringFieldSize(2, result.call.name)
    + encodedMessageFieldSize(3, encodedProtoStructSize(value));
}

function encodedClientToolCallSize(result: NormalizedToolResult): number {
  const call = result.call;
  return encodedVarintFieldSize(1, CALL_MCP_TOOL)
    + encodedMessageFieldSize(62, encodedCallParamsSize(result))
    + encodedStringFieldSize(3, call.id)
    + encodedStringFieldSize(9, call.wireName ?? `${SERVER_NAME}-${call.name}`)
    + encodedStringFieldSize(10, call.arguments)
    + encodedVarintFieldSize(15, 1)
    + encodedVarintFieldSize(48, call.index + 1)
    + (call.modelCallId ? encodedStringFieldSize(49, call.modelCallId) : 0);
}

function encodedClientToolResultSize(result: NormalizedToolResult): number {
  const call = result.call;
  return encodedVarintFieldSize(1, CALL_MCP_TOOL)
    + encodedMessageFieldSize(62, encodedResultParamsSize(result))
    + encodedStringFieldSize(35, call.id)
    + (call.modelCallId ? encodedStringFieldSize(48, call.modelCallId) : 0)
    + encodedVarintFieldSize(49, call.index + 1);
}

function encodedConversationToolResultSize(result: NormalizedToolResult): number {
  const call = result.call;
  return encodedStringFieldSize(1, call.id)
    + encodedStringFieldSize(2, call.wireName ?? `${SERVER_NAME}-${call.name}`)
    + encodedVarintFieldSize(3, call.index + 1)
    + encodedStringFieldSize(4, call.arguments)
    + encodedStringFieldSize(5, call.arguments)
    + encodedStringFieldSize(7, result.result)
    + encodedMessageFieldSize(8, encodedClientToolResultSize(result))
    + encodedMessageFieldSize(11, encodedClientToolCallSize(result))
    + (call.modelCallId ? encodedStringFieldSize(12, call.modelCallId) : 0);
}

function normalizeRequest(request: UnifiedChatRequest): {
  tools: readonly NormalizedTool[];
  messages: readonly NormalizedMessage[];
} {
  requireNonempty(request.model, "Model");
  if (typeof request.system !== "string") throw new TypeError("System prompt must be a string");
  if (!Array.isArray(request.messages) || request.messages.length === 0 || request.messages.length > UNIFIED_CHAT_LIMITS.maxMessages) {
    throw new RangeError(`Request must contain 1-${UNIFIED_CHAT_LIMITS.maxMessages} messages`);
  }
  const requestTools = request.tools ?? [];
  if (!Array.isArray(requestTools) || requestTools.length > UNIFIED_CHAT_LIMITS.maxTools) {
    throw new RangeError(`Request cannot contain more than ${UNIFIED_CHAT_LIMITS.maxTools} tools`);
  }

  let rawBytes = Buffer.byteLength(request.system, "utf8") + Buffer.byteLength(request.model, "utf8");
  let schemaTotal = 0;
  const toolNames = new Set<string>();
  const tools = requestTools.map((tool, index): NormalizedTool => {
    requireNonempty(tool.name, `Tool ${index} name`);
    if (toolNames.has(tool.name)) throw new TypeError(`Duplicate tool name: ${tool.name}`);
    toolNames.add(tool.name);
    if (tool.description !== undefined && typeof tool.description !== "string") {
      throw new TypeError(`Tool ${tool.name} description must be a string`);
    }
    const schema = normalizeJsonObject(tool.parameters, `Tool ${tool.name} schema`);
    if (schema.bytes > UNIFIED_CHAT_LIMITS.maxToolSchemaBytes) {
      throw new RangeError(`Tool ${tool.name} schema exceeds limit`);
    }
    schemaTotal += schema.bytes;
    if (schemaTotal > UNIFIED_CHAT_LIMITS.maxToolSchemaTotalBytes) {
      throw new RangeError("Tool schema total exceeds limit");
    }
    const description = tool.description ?? "";
    rawBytes += Buffer.byteLength(tool.name, "utf8") + Buffer.byteLength(description, "utf8") + schema.bytes;
    return { ...tool, description, schema: schema.object, schemaJson: schema.json };
  });

  let imageCount = 0;
  let imageBytes = 0;
  let toolReplayBytes = 0;
  let encodedToolReplayBytes = 0;
  const callIds = new Set<string>();
  const messages = request.messages.map((message, messageIndex): NormalizedMessage => {
    if (message.role !== "user" && message.role !== "assistant") {
      throw new TypeError(`Message ${messageIndex} has an invalid role`);
    }
    if (message.text !== undefined && typeof message.text !== "string") {
      throw new TypeError(`Message ${messageIndex} text must be a string`);
    }
    const text = message.text ?? "";
    rawBytes += Buffer.byteLength(text, "utf8");
    const images = message.images ?? [];
    if (!Array.isArray(images)) throw new TypeError(`Message ${messageIndex} images must be an array`);
    imageCount += images.length;
    if (imageCount > UNIFIED_CHAT_LIMITS.maxImages) throw new RangeError("Request contains too many images");
    for (const image of images) {
      if (!(image.data instanceof Uint8Array)) throw new TypeError("Image data must be bytes");
      if (image.data.byteLength > UNIFIED_CHAT_LIMITS.maxImageBytes) throw new RangeError("Image bytes exceed per-image limit");
      imageBytes += image.data.byteLength;
      if (imageBytes > UNIFIED_CHAT_LIMITS.maxTotalImageBytes) throw new RangeError("Image byte total exceeds limit");
      if (
        !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) ||
        image.width <= 0 || image.height <= 0 ||
        image.width > UNIFIED_CHAT_LIMITS.maxImageDimension || image.height > UNIFIED_CHAT_LIMITS.maxImageDimension
      ) {
        throw new RangeError("Image dimensions are invalid");
      }
      if (image.uuid !== undefined && !UUID_PATTERN.test(image.uuid)) throw new TypeError("Image UUID is invalid");
      rawBytes += image.data.byteLength + (image.uuid ? Buffer.byteLength(image.uuid, "utf8") : 36);
    }

    const results = message.toolResults ?? [];
    if (!Array.isArray(results)) throw new TypeError(`Message ${messageIndex} tool results must be an array`);
    if (results.length > 0 && message.role !== "assistant") {
      throw new TypeError("Tool results must be replayed in an assistant message");
    }
    const toolResults = results.map((result): NormalizedToolResult => {
      requireNonempty(result.call.id, "Tool call id");
      if (callIds.has(result.call.id)) throw new TypeError(`Duplicate tool call id: ${result.call.id}`);
      callIds.add(result.call.id);
      if (callIds.size > UNIFIED_CHAT_LIMITS.maxTools) {
        throw new RangeError("Request contains too many tool calls");
      }
      requireNonempty(result.call.name, "Tool call name");
      if (!Number.isSafeInteger(result.call.index) || result.call.index < 0) throw new RangeError("Tool call index is invalid");
      requireNonempty(result.call.arguments, "Tool call arguments");
      if (typeof result.result !== "string") throw new TypeError("Tool result must be a string");
      const argumentsBytes = Buffer.byteLength(result.call.arguments, "utf8");
      const resultBytes = Buffer.byteLength(result.result, "utf8");
      if (argumentsBytes > UNIFIED_CHAT_LIMITS.maxToolArgumentsBytes) {
        throw new RangeError("Tool arguments exceed limit");
      }
      if (resultBytes > UNIFIED_CHAT_LIMITS.maxToolResultBytes) {
        throw new RangeError("Tool result exceeds limit");
      }
      toolReplayBytes += argumentsBytes + resultBytes;
      if (toolReplayBytes > UNIFIED_CHAT_LIMITS.maxToolReplayBytes) {
        throw new RangeError("Tool replay content exceeds limit");
      }
      const argumentsObject = parseJsonObject(result.call.arguments);
      if (!argumentsObject) throw new TypeError("Tool call arguments must be a JSON object");
      validateJsonComplexity(argumentsObject, "Tool call arguments");
      if (result.call.modelCallId !== undefined) requireNonempty(result.call.modelCallId, "Model call id");
      if (result.call.serverName !== undefined) requireNonempty(result.call.serverName, "Tool server name");
      if (result.call.wireName !== undefined) requireNonempty(result.call.wireName, "Tool wire name");
      const normalized = { call: result.call, argumentsObject, result: result.result };
      const encodedBytes = encodedMessageFieldSize(
        18,
        encodedConversationToolResultSize(normalized),
      );
      encodedToolReplayBytes += encodedBytes;
      if (encodedToolReplayBytes > UNIFIED_CHAT_LIMITS.maxEncodedToolReplayBytes) {
        throw new RangeError("Encoded tool replay exceeds limit");
      }
      rawBytes += encodedBytes;
      return normalized;
    });

    const serverBubbleId = message.role === "assistant" ? randomUUID() : undefined;
    return { role: message.role, text, images, toolResults, bubbleId: randomUUID(), serverBubbleId };
  });

  if (rawBytes > UNIFIED_CHAT_LIMITS.maxFrameBytes) throw new RangeError("Connect request frame exceeds limit");
  return { tools, messages };
}

function encodeProtoValue(writer: ProtoWriter, value: JsonValue, depth: number): void {
  if (depth > MAX_PROTO_DEPTH) throw new RangeError("JSON schema nesting exceeds limit");
  if (value === null) writer.varint(1, 0);
  else if (typeof value === "number") writer.double(2, value);
  else if (typeof value === "string") writer.bytes(3, value);
  else if (typeof value === "boolean") writer.varint(4, value ? 1 : 0);
  else if (Array.isArray(value)) {
    writer.message(6, (list) => {
      for (const item of value) list.message(1, (entry) => encodeProtoValue(entry, item, depth + 1));
    });
  } else {
    writer.message(5, (struct) => encodeProtoStruct(struct, value, depth));
  }
}

function encodeProtoStruct(writer: ProtoWriter, value: JsonObject, depth = 0): void {
  if (depth > MAX_PROTO_DEPTH) throw new RangeError("JSON schema nesting exceeds limit");
  for (const [key, item] of Object.entries(value)) {
    writer.message(1, (entry) => {
      entry.bytes(1, key);
      entry.message(2, (encoded) => encodeProtoValue(encoded, item, depth + 1));
    });
  }
}

function encodeImage(writer: ProtoWriter, image: UnifiedChatImage): void {
  writer.bytes(1, image.data);
  writer.message(2, (dimensions) => {
    dimensions.varint(1, image.width);
    dimensions.varint(2, image.height);
  });
  writer.bytes(3, image.uuid ?? randomUUID());
}

function encodeMcpDescriptor(writer: ProtoWriter, tool: NormalizedTool): void {
  writer.bytes(1, SERVER_NAME);
  writer.bytes(2, SERVER_NAME);
  writer.bytes(4, "Use this server when the user explicitly requests one of its tools.");
  writer.message(5, (descriptor) => {
    descriptor.bytes(1, tool.name);
    descriptor.bytes(3, tool.description);
    descriptor.message(4, (schema) => encodeProtoStruct(schema, tool.schema));
  });
}

function encodeCallParams(writer: ProtoWriter, result: NormalizedToolResult): void {
  writer.bytes(1, result.call.serverName ?? SERVER_NAME);
  writer.bytes(2, result.call.name);
  writer.message(3, (args) => encodeProtoStruct(args, result.argumentsObject));
}

function encodeResultParams(writer: ProtoWriter, result: NormalizedToolResult): void {
  writer.bytes(1, result.call.serverName ?? SERVER_NAME);
  writer.bytes(2, result.call.name);
  writer.message(3, (struct) => encodeProtoStruct(struct, {
    content: [{ type: "text", text: result.result }],
    isError: false,
  }));
}

function encodeClientToolCall(writer: ProtoWriter, result: NormalizedToolResult): void {
  const call = result.call;
  writer.varint(1, CALL_MCP_TOOL);
  writer.message(62, (params) => encodeCallParams(params, result));
  writer.bytes(3, call.id);
  writer.bytes(9, call.wireName ?? `${SERVER_NAME}-${call.name}`);
  writer.bytes(10, call.arguments);
  writer.varint(15, 1);
  writer.varint(48, call.index + 1);
  if (call.modelCallId) writer.bytes(49, call.modelCallId);
}

function encodeClientToolResult(writer: ProtoWriter, result: NormalizedToolResult): void {
  const call = result.call;
  writer.varint(1, CALL_MCP_TOOL);
  writer.message(62, (params) => encodeResultParams(params, result));
  writer.bytes(35, call.id);
  if (call.modelCallId) writer.bytes(48, call.modelCallId);
  writer.varint(49, call.index + 1);
}

function encodeConversationToolResult(writer: ProtoWriter, result: NormalizedToolResult): void {
  const call = result.call;
  writer.bytes(1, call.id);
  writer.bytes(2, call.wireName ?? `${SERVER_NAME}-${call.name}`);
  writer.varint(3, call.index + 1);
  writer.bytes(4, call.arguments);
  writer.bytes(5, call.arguments);
  writer.bytes(7, result.result);
  writer.message(8, (clientResult) => encodeClientToolResult(clientResult, result));
  writer.message(11, (clientCall) => encodeClientToolCall(clientCall, result));
  if (call.modelCallId) writer.bytes(12, call.modelCallId);
}

function encodeConversationMessage(
  writer: ProtoWriter,
  message: NormalizedMessage,
  toolDescriptors: readonly Uint8Array[],
): void {
  const hasTools = toolDescriptors.length > 0;
  writer.bytes(1, message.text);
  writer.varint(2, message.role === "user" ? 1 : 2);
  for (const image of message.images) writer.message(10, (encoded) => encodeImage(encoded, image));
  writer.bytes(13, message.bubbleId);
  if (message.serverBubbleId) writer.bytes(32, message.serverBubbleId);
  for (const result of message.toolResults) {
    writer.message(18, (encoded) => encodeConversationToolResult(encoded, result));
  }
  writer.varint(20, hasTools ? 1 : 0);
  writer.varint(29, hasTools ? 1 : 0);
  writer.varint(47, hasTools ? MODE_AGENT : MODE_CHAT);
  if (hasTools) writer.packedVarints(51, [CALL_MCP_TOOL]);
  if (message.role === "user") {
    for (const descriptor of toolDescriptors) writer.bytes(83, descriptor);
  }
}

function encodeCurrentFile(writer: ProtoWriter): void {
  const position = (target: ProtoWriter): void => {
    target.varint(1, 0);
    target.varint(2, 0);
  };
  writer.varint(9, 1);
  writer.message(3, position);
  writer.varint(8, 1);
  writer.message(6, (range) => {
    range.message(1, position);
    range.message(2, position);
  });
}

function encodeEnvironment(writer: ProtoWriter): void {
  writer.bytes(1, process.platform);
  writer.bytes(2, process.arch);
  writer.bytes(3, process.version);
  writer.bytes(4, process.env.SHELL ?? "");
  writer.bytes(5, new Date().toISOString());
}

/** Encodes a complete Connect-framed stateless UnifiedChat request. */
export function encodeUnifiedChatRequest(request: UnifiedChatRequest): Uint8Array {
  const { tools, messages } = normalizeRequest(request);
  const hasTools = tools.length > 0;
  const toolDescriptors = tools.map((tool) => {
    const writer = new ProtoWriter();
    encodeMcpDescriptor(writer, tool);
    return writer.finish();
  });
  const toolDefinitions = tools.map((tool) => {
    const writer = new ProtoWriter();
    writer.bytes(1, `${SERVER_NAME}-${tool.name}`);
    writer.bytes(2, tool.description);
    writer.bytes(3, tool.schemaJson);
    writer.bytes(4, SERVER_NAME);
    return writer.finish();
  });
  const userMessageCount = messages.filter((message) => message.role === "user").length;
  const repeatedDescriptorBytes = userMessageCount * toolDescriptors.reduce(
    (total, descriptor) => total + encodedBytesFieldSize(83, descriptor.byteLength),
    0,
  );
  const definitionBytes = toolDefinitions.reduce(
    (total, definition) => total + encodedBytesFieldSize(34, definition.byteLength),
    0,
  );
  const sourceBytes = Buffer.byteLength(request.system, "utf8")
    + Buffer.byteLength(request.model, "utf8")
    + messages.reduce((total, message) => total + Buffer.byteLength(message.text, "utf8")
      + message.images.reduce((sum, image) => sum + image.data.byteLength, 0)
      + message.toolResults.reduce((sum, result) => sum
        + Buffer.byteLength(result.call.arguments, "utf8")
        + Buffer.byteLength(result.result, "utf8"), 0), 0);
  if (repeatedDescriptorBytes + definitionBytes > UNIFIED_CHAT_LIMITS.maxFrameBytes - sourceBytes) {
    throw new RangeError("Repeated tool descriptors exceed the Connect frame limit");
  }
  const root = new ProtoWriter();
  for (const message of messages) {
    root.message(1, (encoded) => encodeConversationMessage(encoded, message, toolDescriptors));
  }
  for (const message of messages) {
    root.message(30, (header) => {
      header.bytes(1, message.bubbleId);
      if (message.serverBubbleId) header.bytes(2, message.serverBubbleId);
      header.varint(3, message.role === "user" ? 1 : 2);
    });
  }
  root.varint(2, hasTools ? 1 : 0);
  root.message(3, (system) => system.bytes(1, request.system));
  root.varint(4, hasTools ? 1 : 0);
  root.message(5, (model) => {
    model.bytes(1, request.model);
    model.message(4, () => undefined);
    model.varint(8, request.maxMode ? 1 : 0);
  });
  root.varint(13, hasTools ? 1 : 0);
  root.message(15, encodeCurrentFile);
  root.varint(17, 0);
  root.varint(19, hasTools ? 1 : 0);
  root.varint(22, hasTools ? 0 : 1);
  root.bytes(23, randomUUID());
  root.message(26, encodeEnvironment);
  root.varint(27, hasTools ? 1 : 0);
  if (hasTools) root.packedVarints(29, [CALL_MCP_TOOL]);
  root.varint(33, hasTools ? 1 : 0);
  for (const definition of toolDefinitions) root.bytes(34, definition);
  root.varint(35, 0);
  root.varint(36, 0);
  root.varint(37, 0);
  root.varint(38, 0);
  root.varint(46, hasTools ? MODE_AGENT : MODE_CHAT);
  if (hasTools) root.packedVarints(47, [CALL_MCP_TOOL]);
  root.varint(48, hasTools ? 0 : 1);
  root.varint(49, 0);
  root.varint(51, 0);
  root.varint(53, hasTools ? 1 : 0);
  root.bytes(54, hasTools ? "Agent" : "Ask");
  if (hasTools) root.varint(90, 1);

  const envelope = new ProtoWriter();
  envelope.message(1, (writer) => writer.appendMessage(root));
  if (envelope.byteLength > UNIFIED_CHAT_LIMITS.maxFrameBytes) {
    throw new RangeError("Connect request frame exceeds limit");
  }
  const framed = new Uint8Array(5 + envelope.byteLength);
  new DataView(framed.buffer).setUint32(1, envelope.byteLength, false);
  let offset = 5;
  for (const chunk of envelope.chunks) {
    framed.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return framed;
}

interface ProtoField {
  fieldNumber: number;
  wireType: 0 | 1 | 2 | 5;
  value: bigint | Uint8Array;
}

class ProtocolDecodeError extends Error {}

function decodeVarint(input: Uint8Array, start: number): { value: bigint; offset: number } {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  for (let count = 0; count < 10; count++) {
    if (offset >= input.byteLength) throw new ProtocolDecodeError("Malformed protobuf response");
    const byte = input[offset];
    offset++;
    if (count === 9 && byte > 1) throw new ProtocolDecodeError("Malformed protobuf response");
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7n;
  }
  throw new ProtocolDecodeError("Malformed protobuf response");
}

function skipGroup(input: Uint8Array, start: number, groupField: number, depth: number): number {
  if (depth > MAX_PROTO_DEPTH) throw new ProtocolDecodeError("Malformed protobuf response");
  let offset = start;
  while (offset < input.byteLength) {
    const parsedTag = decodeVarint(input, offset);
    offset = parsedTag.offset;
    const fieldNumber = Number(parsedTag.value >> 3n);
    const wireType = Number(parsedTag.value & 7n);
    if (wireType === 4) {
      if (fieldNumber !== groupField) throw new ProtocolDecodeError("Malformed protobuf response");
      return offset;
    }
    offset = skipField(input, offset, fieldNumber, wireType, depth + 1);
  }
  throw new ProtocolDecodeError("Malformed protobuf response");
}

function skipField(input: Uint8Array, start: number, fieldNumber: number, wireType: number, depth: number): number {
  if (wireType === 0) return decodeVarint(input, start).offset;
  if (wireType === 1 || wireType === 5) {
    const end = start + (wireType === 1 ? 8 : 4);
    if (end > input.byteLength) throw new ProtocolDecodeError("Malformed protobuf response");
    return end;
  }
  if (wireType === 2) {
    const parsedLength = decodeVarint(input, start);
    if (parsedLength.value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProtocolDecodeError("Malformed protobuf response");
    const end = parsedLength.offset + Number(parsedLength.value);
    if (end < parsedLength.offset || end > input.byteLength) throw new ProtocolDecodeError("Malformed protobuf response");
    return end;
  }
  if (wireType === 3) return skipGroup(input, start, fieldNumber, depth);
  throw new ProtocolDecodeError("Malformed protobuf response");
}

function parseFields(input: Uint8Array): ProtoField[] {
  const result: ProtoField[] = [];
  let offset = 0;
  while (offset < input.byteLength) {
    if (result.length >= MAX_PROTO_FIELDS) throw new ProtocolDecodeError("Malformed protobuf response");
    const parsedTag = decodeVarint(input, offset);
    offset = parsedTag.offset;
    const fieldNumberBig = parsedTag.value >> 3n;
    const wireType = Number(parsedTag.value & 7n);
    if (fieldNumberBig === 0n || fieldNumberBig > 536_870_911n) throw new ProtocolDecodeError("Malformed protobuf response");
    const fieldNumber = Number(fieldNumberBig);
    if (wireType === 3) {
      offset = skipGroup(input, offset, fieldNumber, 1);
      continue;
    }
    if (wireType === 4 || wireType === 6 || wireType === 7) throw new ProtocolDecodeError("Malformed protobuf response");
    if (wireType === 0) {
      const parsed = decodeVarint(input, offset);
      offset = parsed.offset;
      result.push({ fieldNumber, wireType: 0, value: parsed.value });
      continue;
    }
    if (wireType === 1 || wireType === 5) {
      const length = wireType === 1 ? 8 : 4;
      const end = offset + length;
      if (end > input.byteLength) throw new ProtocolDecodeError("Malformed protobuf response");
      result.push({ fieldNumber, wireType, value: input.subarray(offset, end) });
      offset = end;
      continue;
    }
    const parsedLength = decodeVarint(input, offset);
    offset = parsedLength.offset;
    if (parsedLength.value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProtocolDecodeError("Malformed protobuf response");
    const end = offset + Number(parsedLength.value);
    if (end < offset || end > input.byteLength) throw new ProtocolDecodeError("Malformed protobuf response");
    result.push({ fieldNumber, wireType: 2, value: input.subarray(offset, end) });
    offset = end;
  }
  return result;
}

function firstBytes(fields: readonly ProtoField[], fieldNumber: number): Uint8Array | undefined {
  const field = fields.find((candidate) => candidate.fieldNumber === fieldNumber && candidate.wireType === 2);
  return field && field.value instanceof Uint8Array ? field.value : undefined;
}

function firstVarint(fields: readonly ProtoField[], fieldNumber: number): bigint | undefined {
  const field = fields.find((candidate) => candidate.fieldNumber === fieldNumber && candidate.wireType === 0);
  return field && typeof field.value === "bigint" ? field.value : undefined;
}

function decodeText(bytes: Uint8Array | undefined): string {
  if (!bytes) return "";
  try {
    return strictTextDecoder.decode(bytes);
  } catch {
    throw new ProtocolDecodeError("Malformed UTF-8 response");
  }
}

function safeInteger(value: bigint | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProtocolDecodeError(label);
  return Number(value);
}

function decodeProtoValue(input: Uint8Array, depth: number): JsonValue {
  if (depth > MAX_PROTO_DEPTH) throw new ProtocolDecodeError("Malformed protobuf response");
  const fields = parseFields(input);
  if (firstVarint(fields, 1) !== undefined) return null;
  const numberField = fields.find((field) => field.fieldNumber === 2 && field.wireType === 1);
  if (numberField?.value instanceof Uint8Array) {
    const value = new DataView(numberField.value.buffer, numberField.value.byteOffset, 8).getFloat64(0, true);
    if (!Number.isFinite(value)) throw new ProtocolDecodeError("Malformed protobuf response");
    return value;
  }
  const string = firstBytes(fields, 3);
  if (string) return decodeText(string);
  const boolean = firstVarint(fields, 4);
  if (boolean !== undefined) return boolean !== 0n;
  const object = firstBytes(fields, 5);
  if (object) return decodeProtoStruct(object, depth + 1);
  const list = firstBytes(fields, 6);
  if (list) {
    const values: JsonValue[] = [];
    for (const field of parseFields(list)) {
      if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
        values.push(decodeProtoValue(field.value, depth + 1));
      }
    }
    return values;
  }
  throw new ProtocolDecodeError("Malformed protobuf response");
}

function decodeProtoStruct(input: Uint8Array, depth = 0): JsonObject {
  if (depth > MAX_PROTO_DEPTH) throw new ProtocolDecodeError("Malformed protobuf response");
  const entries: Array<readonly [string, JsonValue]> = [];
  for (const field of parseFields(input)) {
    if (field.fieldNumber !== 1 || field.wireType !== 2 || !(field.value instanceof Uint8Array)) continue;
    const entry = parseFields(field.value);
    const key = decodeText(firstBytes(entry, 1));
    const value = firstBytes(entry, 2);
    if (!key || !value) throw new ProtocolDecodeError("Malformed protobuf response");
    entries.push([key, decodeProtoValue(value, depth + 1)]);
  }
  return Object.fromEntries(entries) as JsonObject;
}

interface ToolSnapshot {
  id: string;
  name?: string;
  arguments: string;
  index?: number;
  modelCallId?: string;
  serverName?: string;
  wireName?: string;
  isLast: boolean;
}

interface StoredToolCall extends ToolSnapshot {
  order: number;
  emitted: boolean;
}

function externalToolName(value: string): string {
  const prefix = `${SERVER_NAME}-`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function combineStable(current: string, next: string, message: string): string {
  if (!current) return next;
  if (!next) return current;
  if (current !== next) throw new ProtocolDecodeError(message);
  return current;
}

function mergeArguments(current: string, next: string): string {
  if (!current) return next;
  if (!next || current === next || current.startsWith(next)) return current;
  if (next.startsWith(current)) return next;
  if (parseJsonObject(next) && !parseJsonObject(current)) return next;
  throw new ProtocolDecodeError("Divergent tool call snapshots");
}

function parseToolSnapshot(input: Uint8Array): ToolSnapshot {
  const fields = parseFields(input);
  const id = decodeText(firstBytes(fields, 3));
  if (!id) throw new ProtocolDecodeError("Tool call is missing an id");

  let serverName = "";
  let name = "";
  let rawArguments = decodeText(firstBytes(fields, 10));
  let hasStructuredArguments = false;
  const direct = firstBytes(fields, 62);
  if (direct) {
    const params = parseFields(direct);
    serverName = decodeText(firstBytes(params, 1));
    name = externalToolName(decodeText(firstBytes(params, 2)));
    const args = firstBytes(params, 3);
    if (args) {
      rawArguments = JSON.stringify(decodeProtoStruct(args));
      hasStructuredArguments = true;
    }
  }
  const alternate = firstBytes(fields, 27);
  if (alternate) {
    const params = parseFields(alternate);
    const toolBytes = firstBytes(params, 1);
    if (toolBytes) {
      const tool = parseFields(toolBytes);
      name ||= externalToolName(decodeText(firstBytes(tool, 1)));
      const alternateArguments = decodeText(firstBytes(tool, 3));
      if (alternateArguments && !hasStructuredArguments) rawArguments = alternateArguments;
      serverName ||= decodeText(firstBytes(tool, 4));
    }
  }
  const rawWireName = decodeText(firstBytes(fields, 9));
  name ||= externalToolName(rawWireName);
  if (
    serverName
    && serverName !== SERVER_NAME
    && serverName !== "unknown"
    && serverName !== name
  ) {
    throw new ProtocolDecodeError("Unexpected tool call namespace");
  }
  const wireIndex = safeInteger(firstVarint(fields, 48), "Tool call index is invalid");
  const index = wireIndex === undefined ? 0 : Math.max(0, wireIndex - 1);
  const modelCallId = decodeText(firstBytes(fields, 49)) || undefined;
  const isLast = (firstVarint(fields, 15) ?? firstVarint(fields, 11) ?? 0n) !== 0n;
  const replayServerName = serverName && serverName !== SERVER_NAME ? serverName : undefined;
  const replayWireName = rawWireName && rawWireName !== `${SERVER_NAME}-${name}`
    ? rawWireName
    : undefined;
  return {
    id,
    name: name || undefined,
    arguments: rawArguments,
    index,
    modelCallId,
    serverName: replayServerName,
    wireName: replayWireName,
    isLast,
  };
}

function mergeSnapshot(previous: StoredToolCall | undefined, next: ToolSnapshot, order: number): StoredToolCall {
  if (!previous) return { ...next, order, emitted: false };
  const name = previous.name && next.name
    ? combineStable(previous.name, next.name, "Conflicting tool call names")
    : previous.name ?? next.name;
  const index = previous.index !== undefined && next.index !== undefined
    ? Number(combineStable(String(previous.index), String(next.index), "Conflicting tool call indexes"))
    : previous.index ?? next.index;
  const modelCallId = previous.modelCallId && next.modelCallId
    ? combineStable(previous.modelCallId, next.modelCallId, "Conflicting model call ids")
    : previous.modelCallId ?? next.modelCallId;
  const serverName = previous.serverName && next.serverName
    ? combineStable(previous.serverName, next.serverName, "Conflicting tool server names")
    : previous.serverName ?? next.serverName;
  const wireName = previous.wireName && next.wireName
    ? combineStable(previous.wireName, next.wireName, "Conflicting tool wire names")
    : previous.wireName ?? next.wireName;
  const argumentsValue = mergeArguments(previous.arguments, next.arguments);
  if (previous.emitted && (
    argumentsValue !== previous.arguments || name !== previous.name || index !== previous.index ||
    modelCallId !== previous.modelCallId || serverName !== previous.serverName || wireName !== previous.wireName
  )) {
    throw new ProtocolDecodeError("Tool call changed after completion");
  }
  return {
    id: previous.id,
    name,
    arguments: argumentsValue,
    index,
    modelCallId,
    serverName,
    wireName,
    isLast: previous.isLast || next.isLast,
    order: previous.order,
    emitted: previous.emitted,
  };
}

function retryableCode(code: string): boolean {
  return new Set(["aborted", "deadline_exceeded", "internal", "resource_exhausted", "unavailable"]).has(code);
}

function safeTrailerMessage(value: unknown): string {
  if (typeof value !== "string") return "Upstream request failed";
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return normalized ? normalized.slice(0, 512) : "Upstream request failed";
}

/** Incrementally decodes Connect-framed UnifiedChat responses. */
export class UnifiedChatResponseDecoder {
  private readonly header = new Uint8Array(5);
  private headerOffset = 0;
  private payload: Uint8Array | undefined;
  private payloadOffset = 0;
  private flags = 0;
  private receivedBytes = 0;
  private declaredBytes = 0;
  private decodedBytes = 0;
  private failed = false;
  private finished = false;
  private sawTrailer = false;
  private hadOutput = false;
  private callOrder = 0;
  private readonly calls = new Map<string, StoredToolCall>();

  push(chunk: Uint8Array): UnifiedChatEvent[] {
    if (this.failed || this.finished) return [];
    if (!(chunk instanceof Uint8Array)) return this.fail("Response chunk must be bytes");
    if (chunk.byteLength > UNIFIED_CHAT_LIMITS.maxResponseBytes - this.receivedBytes) {
      return this.fail("UnifiedChat response exceeds limit");
    }
    this.receivedBytes += chunk.byteLength;
    const events: UnifiedChatEvent[] = [];
    let offset = 0;
    while (offset < chunk.byteLength && !this.failed) {
      if (this.sawTrailer) return [...events, ...this.fail("Data followed the Connect end-stream trailer")];
      if (!this.payload) {
        const headerBytes = Math.min(5 - this.headerOffset, chunk.byteLength - offset);
        this.header.set(chunk.subarray(offset, offset + headerBytes), this.headerOffset);
        this.headerOffset += headerBytes;
        offset += headerBytes;
        if (this.headerOffset < 5) continue;
        this.flags = this.header[0];
        if ((this.flags & ~3) !== 0) return [...events, ...this.fail("Unsupported Connect frame flags")];
        if (this.flags === 3) return [...events, ...this.fail("Unsupported Connect compression")];
        const payloadLength = new DataView(this.header.buffer).getUint32(1, false);
        if (payloadLength > UNIFIED_CHAT_LIMITS.maxFrameBytes) {
          return [...events, ...this.fail("Connect frame exceeds limit")];
        }
        if (payloadLength + 5 > UNIFIED_CHAT_LIMITS.maxResponseBytes - this.declaredBytes) {
          return [...events, ...this.fail("UnifiedChat response exceeds limit")];
        }
        this.declaredBytes += payloadLength + 5;
        this.payload = new Uint8Array(payloadLength);
        this.payloadOffset = 0;
        if (payloadLength === 0) {
          const frameEvents = this.completeFrame(this.payload);
          events.push(...frameEvents);
          this.resetFrame();
        }
        continue;
      }
      const payloadBytes = Math.min(this.payload.byteLength - this.payloadOffset, chunk.byteLength - offset);
      this.payload.set(chunk.subarray(offset, offset + payloadBytes), this.payloadOffset);
      this.payloadOffset += payloadBytes;
      offset += payloadBytes;
      if (this.payloadOffset === this.payload.byteLength) {
        events.push(...this.completeFrame(this.payload));
        this.resetFrame();
      }
    }
    return events;
  }

  finish(): UnifiedChatEvent[] {
    if (this.failed || this.finished) return [];
    if (this.headerOffset !== 0 || this.payload !== undefined) return this.fail("Truncated Connect frame");
    const events: UnifiedChatEvent[] = [];
    try {
      const pending = [...this.calls.values()]
        .filter((call) => !call.emitted)
        .sort((left, right) => (left.index ?? 0) - (right.index ?? 0) || left.order - right.order);
      for (const call of pending) events.push(this.finalizeCall(call));
    } catch (error) {
      return this.decodeFailure(error);
    }
    if (!this.hadOutput) return this.fail("UnifiedChat response was empty");
    this.finished = true;
    events.push({ type: "end" });
    return events;
  }

  private resetFrame(): void {
    this.headerOffset = 0;
    this.payload = undefined;
    this.payloadOffset = 0;
    this.flags = 0;
  }

  private completeFrame(payload: Uint8Array): UnifiedChatEvent[] {
    try {
      if ((this.flags & 2) !== 0) return this.parseTrailer(payload);
      let decoded = payload;
      if ((this.flags & 1) !== 0) {
        const remaining = UNIFIED_CHAT_LIMITS.maxResponseBytes - this.decodedBytes;
        try {
          decoded = gunzipSync(payload, { maxOutputLength: Math.max(1, remaining) });
        } catch {
          throw new ProtocolDecodeError("Invalid gzip response frame");
        }
      }
      if (decoded.byteLength > UNIFIED_CHAT_LIMITS.maxResponseBytes - this.decodedBytes) {
        throw new ProtocolDecodeError("UnifiedChat response exceeds limit");
      }
      this.decodedBytes += decoded.byteLength;
      const events: UnifiedChatEvent[] = [];
      for (const field of parseFields(decoded)) {
        if (field.wireType !== 2 || !(field.value instanceof Uint8Array)) continue;
        if (field.fieldNumber === 1) {
          const snapshot = parseToolSnapshot(field.value);
          if (!this.calls.has(snapshot.id) && this.calls.size >= UNIFIED_CHAT_LIMITS.maxTools) {
            throw new ProtocolDecodeError("UnifiedChat response contains too many tool calls");
          }
          const merged = mergeSnapshot(this.calls.get(snapshot.id), snapshot, this.callOrder++);
          this.calls.set(snapshot.id, merged);
        } else if (field.fieldNumber === 2) {
          for (const responseField of parseFields(field.value)) {
            if (responseField.wireType !== 2 || !(responseField.value instanceof Uint8Array)) continue;
            if (responseField.fieldNumber === 1) {
              const text = decodeText(responseField.value);
              if (text) {
                this.hadOutput = true;
                events.push({ type: "text", text });
              }
            } else if (responseField.fieldNumber === 25) {
              for (const reasoningField of parseFields(responseField.value)) {
                if (reasoningField.fieldNumber !== 1 || reasoningField.wireType !== 2 || !(reasoningField.value instanceof Uint8Array)) continue;
                const text = decodeText(reasoningField.value);
                if (text) {
                  this.hadOutput = true;
                  events.push({ type: "reasoning", text });
                }
              }
            }
          }
        } else if (field.fieldNumber === 5) {
          events.push({ type: "metadata" });
        }
      }
      return events;
    } catch (error) {
      return this.decodeFailure(error);
    }
  }

  private parseTrailer(payload: Uint8Array): UnifiedChatEvent[] {
    this.sawTrailer = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeText(payload));
    } catch (error) {
      if (error instanceof ProtocolDecodeError) throw error;
      throw new ProtocolDecodeError("Malformed Connect end-stream trailer");
    }
    if (!isObject(parsed)) throw new ProtocolDecodeError("Malformed Connect end-stream trailer");
    const events: UnifiedChatEvent[] = [];
    if (parsed.metadata !== undefined) events.push({ type: "metadata" });
    if (parsed.error === undefined) return events;
    if (!isObject(parsed.error)) throw new ProtocolDecodeError("Malformed Connect end-stream trailer");
    const rawCode = parsed.error.code;
    const code = typeof rawCode === "string" && /^[a-z0-9_-]{1,64}$/i.test(rawCode) ? rawCode : "unknown";
    if (code.toLowerCase() === "aborted" && this.calls.size > 0) return events;
    this.failed = true;
    events.push({
      type: "error",
      code,
      message: safeTrailerMessage(parsed.error.message),
      retryable: retryableCode(code.toLowerCase()),
    });
    return events;
  }

  private finalizeCall(call: StoredToolCall): UnifiedChatEvent {
    if (!call.name) throw new ProtocolDecodeError("Tool call is missing a name");
    const argumentsValue = call.arguments || "{}";
    if (!parseJsonObject(argumentsValue)) throw new ProtocolDecodeError("Tool call arguments are not a JSON object");
    call.emitted = true;
    this.calls.set(call.id, call);
    this.hadOutput = true;
    const finalized: UnifiedChatToolCall = {
      id: call.id,
      name: call.name,
      index: call.index ?? 0,
      arguments: argumentsValue,
    };
    if (call.modelCallId) finalized.modelCallId = call.modelCallId;
    if (call.serverName) finalized.serverName = call.serverName;
    if (call.wireName) finalized.wireName = call.wireName;
    return { type: "tool-call", call: finalized };
  }

  private decodeFailure(error: unknown): UnifiedChatEvent[] {
    return this.fail(error instanceof ProtocolDecodeError ? error.message : "Malformed UnifiedChat response");
  }

  private fail(message: string): UnifiedChatEvent[] {
    this.failed = true;
    this.payload = undefined;
    return [{ type: "error", code: "protocol_error", message, retryable: false }];
  }
}
