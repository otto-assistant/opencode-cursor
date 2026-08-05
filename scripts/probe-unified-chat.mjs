#!/usr/bin/env node

/**
 * Read-only capability probe for Cursor's UnifiedChat endpoint.
 *
 * Required: CURSOR_ACCESS_TOKEN
 * Optional: CURSOR_MACHINE_ID, CURSOR_MODEL (exact public model ID), CURSOR_CLIENT_VERSION,
 * CURSOR_PROBE_STAGE (text, image, history, tool, or all), CURSOR_PROBE_MAX_MODE (0 or 1),
 * CURSOR_PROBE_TOOL_SERVER, and CURSOR_PROBE_TOOL_NAME.
 *
 * The probe never prints credentials and does not write files.
 */
import http2 from "node:http2";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { gunzipSync, deflateSync } from "node:zlib";

const ENDPOINT = process.env.CURSOR_UNIFIED_CHAT_URL ??
  "https://api2.cursor.sh/aiserver.v1.ChatService/StreamUnifiedChatWithTools";
const ACCESS_TOKEN = cleanToken(process.env.CURSOR_ACCESS_TOKEN ?? "");
const MODEL = process.env.CURSOR_MODEL ?? "claude-4.6-sonnet-medium";
const CLIENT_VERSION = process.env.CURSOR_CLIENT_VERSION ?? "3.1.0";
const STAGE = process.env.CURSOR_PROBE_STAGE ?? "all";
const MAX_MODE = process.env.CURSOR_PROBE_MAX_MODE === "1";
const REQUEST_TIMEOUT_MS = Number(process.env.CURSOR_PROBE_TIMEOUT_MS ?? 120_000);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ROLE = { USER: 1, ASSISTANT: 2 };
const MODE = { CHAT: 1, AGENT: 2 };
const THINKING = { UNSPECIFIED: 0, MEDIUM: 1, HIGH: 2 };
const CALL_MCP_TOOL = 49;

function cleanToken(token) {
  const separator = token.indexOf("::");
  return separator >= 0 ? token.slice(separator + 2) : token;
}

function fail(message) {
  throw new Error(message);
}

function concat(...parts) {
  const buffers = parts.flat().filter((part) => part != null).map((part) => Buffer.from(part));
  return Buffer.concat(buffers);
}

function varint(input) {
  let value = BigInt(input);
  if (value < 0n) value = BigInt.asUintN(64, value);
  const bytes = [];
  do {
    let byte = Number(value & 0x7fn);
    value >>= 7n;
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return Buffer.from(bytes);
}

function tag(fieldNumber, wireType) {
  return varint((BigInt(fieldNumber) << 3n) | BigInt(wireType));
}

function fieldVarint(fieldNumber, value) {
  return concat(tag(fieldNumber, 0), varint(value));
}

function fieldBytes(fieldNumber, value) {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  return concat(tag(fieldNumber, 2), varint(bytes.length), bytes);
}

function fieldMessage(fieldNumber, ...parts) {
  return fieldBytes(fieldNumber, concat(...parts));
}

function fieldPackedVarints(fieldNumber, values) {
  return fieldBytes(fieldNumber, concat(values.map(varint)));
}

function fieldDouble(fieldNumber, value) {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleLE(value);
  return concat(tag(fieldNumber, 1), bytes);
}

function encodeProtoValue(value) {
  if (value == null) return fieldVarint(1, 0);
  if (typeof value === "number") return fieldDouble(2, value);
  if (typeof value === "string") return fieldBytes(3, value);
  if (typeof value === "boolean") return fieldVarint(4, value ? 1 : 0);
  if (Array.isArray(value)) {
    return fieldMessage(6, value.map((item) => fieldMessage(1, encodeProtoValue(item))));
  }
  return fieldMessage(5, encodeProtoStruct(value));
}

function encodeProtoStruct(value) {
  return concat(
    Object.entries(value ?? {}).map(([key, item]) =>
      fieldMessage(1, fieldBytes(1, key), fieldMessage(2, encodeProtoValue(item)))
    ),
  );
}

function encodeImage(image) {
  const dimension = concat(fieldVarint(1, image.width), fieldVarint(2, image.height));
  return concat(
    fieldBytes(1, image.data),
    fieldMessage(2, dimension),
    fieldBytes(3, image.uuid ?? randomUUID()),
  );
}

function encodeMcpTool(tool) {
  return concat(
    fieldBytes(1, tool.name),
    fieldBytes(2, tool.description ?? ""),
    fieldBytes(3, JSON.stringify(tool.parameters ?? {})),
    fieldBytes(4, tool.serverName ?? "opencode-probe"),
  );
}

function encodeMcpDescriptor(tool) {
  const toolName = tool.toolName ?? tool.name;
  const toolDescriptor = concat(
    fieldBytes(1, toolName),
    fieldBytes(3, tool.description ?? ""),
    fieldMessage(4, encodeProtoStruct(tool.parameters ?? {})),
  );
  return concat(
    fieldBytes(1, tool.serverName ?? "opencode-probe"),
    fieldBytes(2, tool.serverName ?? "opencode-probe"),
    fieldBytes(4, "Use this server when the user explicitly requests one of its tools."),
    fieldMessage(5, toolDescriptor),
  );
}

function encodeCallMcpToolParams(call) {
  return concat(
    fieldBytes(1, call.serverName),
    fieldBytes(2, call.toolName),
    fieldMessage(3, encodeProtoStruct(call.args ?? {})),
  );
}

function encodeCallMcpToolResult(call, result) {
  return concat(
    fieldBytes(1, call.serverName),
    fieldBytes(2, call.toolName),
    fieldMessage(3, encodeProtoStruct({
      content: [{ type: "text", text: result }],
      isError: false,
    })),
  );
}

function encodeClientToolCall(call) {
  return concat(
    fieldVarint(1, CALL_MCP_TOOL),
    fieldMessage(62, encodeCallMcpToolParams(call)),
    fieldBytes(3, call.toolCallId),
    fieldBytes(9, call.wireName),
    fieldBytes(10, call.rawArgs),
    fieldVarint(15, 1),
    fieldVarint(48, call.toolIndex),
    call.modelCallId ? fieldBytes(49, call.modelCallId) : null,
  );
}

function encodeClientToolResult(call, result) {
  return concat(
    fieldVarint(1, CALL_MCP_TOOL),
    fieldMessage(62, encodeCallMcpToolResult(call, result)),
    fieldBytes(35, call.toolCallId),
    call.modelCallId ? fieldBytes(48, call.modelCallId) : null,
    fieldVarint(49, call.toolIndex),
  );
}

function encodeConversationToolResult(call, result) {
  return concat(
    fieldBytes(1, call.toolCallId),
    fieldBytes(2, call.wireName),
    fieldVarint(3, call.toolIndex),
    fieldBytes(4, call.rawArgs),
    fieldBytes(5, call.rawArgs),
    fieldBytes(7, result),
    fieldMessage(8, encodeClientToolResult(call, result)),
    fieldMessage(11, encodeClientToolCall(call)),
    call.modelCallId ? fieldBytes(12, call.modelCallId) : null,
  );
}

function encodeConversationMessage(message, tools) {
  const hasTools = tools.length > 0;
  const mode = hasTools ? MODE.AGENT : MODE.CHAT;
  return concat(
    fieldBytes(1, message.text ?? ""),
    fieldVarint(2, message.role),
    (message.images ?? []).map((image) => fieldMessage(10, encodeImage(image))),
    fieldBytes(13, message.bubbleId ?? randomUUID()),
    message.serverBubbleId ? fieldBytes(32, message.serverBubbleId) : null,
    (message.toolResults ?? []).map(({ call, result }) =>
      fieldMessage(18, encodeConversationToolResult(call, result))
    ),
    fieldVarint(20, hasTools ? 1 : 0),
    fieldVarint(29, hasTools ? 1 : 0),
    fieldVarint(47, mode),
    hasTools ? fieldPackedVarints(51, [CALL_MCP_TOOL]) : null,
    message.role === ROLE.USER
      ? tools.map((tool) => fieldMessage(83, encodeMcpDescriptor(tool)))
      : null,
  );
}

function encodeConversationHeader(message) {
  return concat(
    fieldBytes(1, message.bubbleId),
    message.serverBubbleId ? fieldBytes(2, message.serverBubbleId) : null,
    fieldVarint(3, message.role),
  );
}

function encodeModelDetails(model, maxMode) {
  return concat(
    fieldBytes(1, model),
    fieldMessage(4),
    fieldVarint(8, maxMode ? 1 : 0),
  );
}

function encodeCurrentFile() {
  const position = concat(fieldVarint(1, 0), fieldVarint(2, 0));
  const range = concat(fieldMessage(1, position), fieldMessage(2, position));
  return concat(
    fieldVarint(9, 1),
    fieldMessage(3, position),
    fieldVarint(8, 1),
    fieldMessage(6, range),
  );
}

function encodeEnvironment() {
  return concat(
    fieldBytes(1, process.platform),
    fieldBytes(2, process.arch),
    fieldBytes(3, process.version),
    fieldBytes(4, process.env.SHELL ?? ""),
    fieldBytes(5, new Date().toISOString()),
  );
}

function encodeUnifiedRequest({
  messages,
  tools = [],
  system = "You are a precise assistant.",
  model = MODEL,
  conversationId = randomUUID(),
  maxMode = MAX_MODE,
  thinking = THINKING.UNSPECIFIED,
  longContext = false,
}) {
  const hasTools = tools.length > 0;
  const normalized = messages.map((message) => ({
    ...message,
    bubbleId: message.bubbleId ?? randomUUID(),
    serverBubbleId:
      message.role === ROLE.ASSISTANT
        ? (message.serverBubbleId ?? randomUUID())
        : undefined,
  }));
  const request = concat(
    normalized.map((message) =>
      fieldMessage(1, encodeConversationMessage(message, tools))
    ),
    normalized.map((message) =>
      fieldMessage(30, encodeConversationHeader(message))
    ),
    fieldVarint(2, hasTools ? 1 : 0),
    fieldMessage(3, fieldBytes(1, system)),
    fieldVarint(4, hasTools ? 1 : 0),
    fieldMessage(5, encodeModelDetails(model, maxMode)),
    fieldVarint(13, hasTools ? 1 : 0),
    fieldMessage(15, encodeCurrentFile()),
    fieldVarint(17, 0),
    fieldVarint(19, hasTools ? 1 : 0),
    fieldVarint(22, hasTools ? 0 : 1),
    fieldBytes(23, conversationId),
    fieldMessage(26, encodeEnvironment()),
    fieldVarint(27, hasTools ? 1 : 0),
    hasTools ? fieldPackedVarints(29, [CALL_MCP_TOOL]) : null,
    fieldVarint(33, hasTools ? 1 : 0),
    tools.map((tool) => fieldMessage(34, encodeMcpTool(tool))),
    fieldVarint(35, longContext ? 1 : 0),
    fieldVarint(36, 0),
    fieldVarint(37, 0),
    fieldVarint(38, 0),
    fieldVarint(46, hasTools ? MODE.AGENT : MODE.CHAT),
    hasTools ? fieldPackedVarints(47, [CALL_MCP_TOOL]) : null,
    fieldVarint(48, hasTools ? 0 : 1),
    fieldVarint(49, thinking),
    fieldVarint(51, 0),
    fieldVarint(53, hasTools ? 1 : 0),
    fieldBytes(54, hasTools ? "Agent" : "Ask"),
    hasTools ? fieldVarint(90, 1) : null,
  );
  return { conversationId, payload: fieldMessage(1, request) };
}

function connectFrame(payload) {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0;
  frame.writeUInt32BE(payload.length, 1);
  Buffer.from(payload).copy(frame, 5);
  return frame;
}

function decodeVarint(buffer, start) {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < buffer.length) {
    const byte = buffer[offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      const number = Number(value);
      return { value: Number.isSafeInteger(number) ? number : value, offset };
    }
    shift += 7n;
    if (shift > 70n) fail("Invalid protobuf varint");
  }
  fail("Truncated protobuf varint");
}

function parseFields(input) {
  const buffer = Buffer.from(input);
  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    const parsedTag = decodeVarint(buffer, offset);
    offset = parsedTag.offset;
    const numericTag = Number(parsedTag.value);
    const fieldNumber = numericTag >>> 3;
    const wireType = numericTag & 7;
    if (wireType === 0) {
      const parsed = decodeVarint(buffer, offset);
      offset = parsed.offset;
      fields.push({ fieldNumber, wireType, value: parsed.value });
      continue;
    }
    if (wireType === 2) {
      const parsedLength = decodeVarint(buffer, offset);
      offset = parsedLength.offset;
      const length = Number(parsedLength.value);
      const end = offset + length;
      if (end > buffer.length) fail("Truncated protobuf field");
      fields.push({ fieldNumber, wireType, value: buffer.subarray(offset, end) });
      offset = end;
      continue;
    }
    if (wireType === 1) {
      const end = offset + 8;
      if (end > buffer.length) fail("Truncated protobuf fixed64 field");
      fields.push({ fieldNumber, wireType, value: buffer.subarray(offset, end) });
      offset = end;
      continue;
    }
    if (wireType === 5) {
      const end = offset + 4;
      if (end > buffer.length) fail("Truncated protobuf fixed32 field");
      fields.push({ fieldNumber, wireType, value: buffer.subarray(offset, end) });
      offset = end;
      continue;
    }
    fail(`Unsupported protobuf wire type ${wireType}`);
  }
  return fields;
}

function firstBytes(fields, fieldNumber) {
  return fields.find((field) => field.fieldNumber === fieldNumber && field.wireType === 2)?.value;
}

function firstNumber(fields, fieldNumber) {
  return fields.find((field) => field.fieldNumber === fieldNumber && field.wireType === 0)?.value;
}

function text(bytes) {
  return bytes ? decoder.decode(bytes) : "";
}

function decodeProtoValue(bytes) {
  const fields = parseFields(bytes);
  if (firstNumber(fields, 1) != null) return null;
  const number = fields.find((field) => field.fieldNumber === 2 && field.wireType === 1)?.value;
  if (number) return Buffer.from(number).readDoubleLE();
  const string = firstBytes(fields, 3);
  if (string) return text(string);
  const boolean = firstNumber(fields, 4);
  if (boolean != null) return Boolean(boolean);
  const object = firstBytes(fields, 5);
  if (object) return decodeProtoStruct(object);
  const list = firstBytes(fields, 6);
  if (list) {
    return parseFields(list)
      .filter((field) => field.fieldNumber === 1 && field.wireType === 2)
      .map((field) => decodeProtoValue(field.value));
  }
  return undefined;
}

function decodeProtoStruct(bytes) {
  const result = {};
  for (const entryField of parseFields(bytes).filter(
    (field) => field.fieldNumber === 1 && field.wireType === 2
  )) {
    const entry = parseFields(entryField.value);
    const key = text(firstBytes(entry, 1));
    const value = firstBytes(entry, 2);
    if (key && value) result[key] = decodeProtoValue(value);
  }
  return result;
}

function parseToolCall(bytes) {
  const fields = parseFields(bytes);
  const mcpParamsBytes = firstBytes(fields, 27);
  let toolName = text(firstBytes(fields, 9));
  let rawArgs = text(firstBytes(fields, 10));
  let serverName = "opencode-probe";
  let args;
  const directParamsBytes = firstBytes(fields, 62);
  if (directParamsBytes) {
    const directParams = parseFields(directParamsBytes);
    serverName = text(firstBytes(directParams, 1)) || serverName;
    toolName = text(firstBytes(directParams, 2)) || toolName;
    const argsBytes = firstBytes(directParams, 3);
    if (argsBytes) {
      args = decodeProtoStruct(argsBytes);
      rawArgs = JSON.stringify(args);
    }
  }
  if (mcpParamsBytes) {
    const mcpParams = parseFields(mcpParamsBytes);
    const toolBytes = firstBytes(mcpParams, 1);
    if (toolBytes) {
      const tool = parseFields(toolBytes);
      toolName = text(firstBytes(tool, 1)) || toolName;
      rawArgs = text(firstBytes(tool, 3)) || rawArgs;
      serverName = text(firstBytes(tool, 4)) || serverName;
    }
  }
  const wireName = text(firstBytes(fields, 9)) || toolName;
  const toolCallId = text(firstBytes(fields, 3));
  if (!toolCallId || !toolName) return null;
  return {
    toolCallId,
    modelCallId: text(firstBytes(fields, 49)) || undefined,
    toolIndex: Number(firstNumber(fields, 48) ?? 1),
    toolName,
    wireName,
    rawArgs: rawArgs || "{}",
    args,
    serverName,
    isLast: Boolean(firstNumber(fields, 15) ?? firstNumber(fields, 11)),
  };
}

function mergeToolCall(previous, next) {
  if (!previous) return next;
  const oldArgs = previous.rawArgs || "";
  const newArgs = next.rawArgs || "";
  let rawArgs = oldArgs;
  if (newArgs.startsWith(oldArgs)) rawArgs = newArgs;
  else if (!oldArgs.startsWith(newArgs)) rawArgs = oldArgs + newArgs;
  return {
    ...previous,
    ...next,
    rawArgs,
    args: next.args ?? previous.args,
    toolName: next.toolName || previous.toolName,
    wireName: next.wireName || previous.wireName,
    serverName: next.serverName || previous.serverName,
    modelCallId: next.modelCallId || previous.modelCallId,
  };
}

function parseConnectTrailer(payload) {
  let value;
  try {
    value = JSON.parse(text(payload));
  } catch {
    return "MALFORMED_CONNECT_TRAILER";
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "MALFORMED_CONNECT_TRAILER";
  }
  if (!value.error) return null;
  const code = typeof value.error?.code === "string" ? value.error.code : "unknown";
  const message = typeof value.error?.message === "string"
    ? value.error.message.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200)
    : "Error";
  return `CONNECT_${code.toUpperCase()}: ${message || "Error"}`;
}

function parseConnectResponse(input) {
  const buffer = Buffer.from(input);
  const result = { text: "", reasoning: "", toolCalls: [], errors: [], field5Diagnostics: [], unknownOuterFields: new Set() };
  const calls = new Map();
  let offset = 0;
  while (offset + 5 <= buffer.length) {
    const flags = buffer[offset];
    const length = buffer.readUInt32BE(offset + 1);
    const end = offset + 5 + length;
    if (end > buffer.length) {
      result.errors.push("Truncated Connect frame");
      break;
    }
    let payload = buffer.subarray(offset + 5, end);
    offset = end;
    if ((flags & 1) !== 0) {
      try {
        payload = gunzipSync(payload);
      } catch {
        result.errors.push("Could not decompress response frame");
        continue;
      }
    }
    if ((flags & 2) !== 0) {
      const trailerError = parseConnectTrailer(payload);
      if (trailerError) result.errors.push(trailerError);
      continue;
    }
    try {
      const outer = parseFields(payload);
      for (const field of outer) {
        if (![1, 2, 5].includes(field.fieldNumber)) result.unknownOuterFields.add(field.fieldNumber);
      }
      for (const field of outer.filter((candidate) => candidate.fieldNumber === 1 && candidate.wireType === 2)) {
        const call = parseToolCall(field.value);
        if (call) calls.set(call.toolCallId, mergeToolCall(calls.get(call.toolCallId), call));
      }
      for (const field of outer.filter((candidate) => candidate.fieldNumber === 2 && candidate.wireType === 2)) {
        const response = parseFields(field.value);
        result.text += text(firstBytes(response, 1));
        const thinkingBytes = firstBytes(response, 25);
        if (thinkingBytes) result.reasoning += text(firstBytes(parseFields(thinkingBytes), 1));
      }
      for (const field of outer.filter((candidate) => candidate.fieldNumber === 5 && candidate.wireType === 2)) {
        const nested = parseFields(field.value).map((item) => ({
          fieldNumber: item.fieldNumber,
          wireType: item.wireType,
          text: item.wireType === 2 ? concise(text(item.value), 120) : undefined,
          length: item.wireType === 2 ? item.value.length : undefined,
        }));
        result.field5Diagnostics.push(nested);
      }
    } catch (error) {
      result.errors.push(`Response decode failed: ${error.message}`);
    }
  }
  result.toolCalls = [...calls.values()];
  return result;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function uuidV5Dns(value) {
  const dnsNamespace = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
  const digest = createHash("sha1").update(dnsNamespace).update(value).digest().subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function cursorChecksum(machineId) {
  const timestamp = Math.floor(Date.now() / 1_000_000);
  const bytes = Buffer.from([
    Math.floor(timestamp / 2 ** 40) & 0xff,
    Math.floor(timestamp / 2 ** 32) & 0xff,
    (timestamp >>> 24) & 0xff,
    (timestamp >>> 16) & 0xff,
    (timestamp >>> 8) & 0xff,
    timestamp & 0xff,
  ]);
  let previous = 165;
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = ((bytes[index] ^ previous) + (index & 0xff)) & 0xff;
    previous = bytes[index];
  }
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    encoded += BASE64URL_ALPHABET[a >> 2];
    encoded += BASE64URL_ALPHABET[((a & 3) << 4) | (b >> 4)];
    if (index + 1 < bytes.length) encoded += BASE64URL_ALPHABET[((b & 15) << 2) | (c >> 6)];
    if (index + 2 < bytes.length) encoded += BASE64URL_ALPHABET[c & 63];
  }
  return `${encoded}${machineId}`;
}

function requestHeaders(token, machineId) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/connect+proto",
    accept: "application/connect+proto",
    "accept-encoding": "gzip",
    "connect-protocol-version": "1",
    "user-agent": "connect-es/1.6.1",
    "x-amzn-trace-id": randomUUID(),
    "x-client-key": sha256(token),
    "x-cursor-checksum": cursorChecksum(machineId),
    "x-cursor-client-version": CLIENT_VERSION,
    "x-cursor-client-type": "ide",
    "x-cursor-client-os": process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
    "x-cursor-client-arch": process.arch,
    "x-cursor-client-device-type": "desktop",
    "x-cursor-config-version": randomUUID(),
    "x-cursor-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    "x-ghost-mode": "false",
    "x-new-onboarding-completed": "true",
    "x-session-id": uuidV5Dns(token),
    "x-request-id": randomUUID(),
    ...(process.env.CURSOR_PROBE_TE_TRAILERS === "1" ? { te: "trailers" } : {}),
  };
}

async function callUnified(payload, token, machineId) {
  const url = new URL(ENDPOINT);
  const client = http2.connect(url.origin);
  const chunks = [];
  let responseHeaders;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { client.destroy(); } catch {}
      reject(new Error(`UnifiedChat request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);
    const finish = (callback) => (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client.close(); } catch {}
      callback(value);
    };
    client.once("error", finish(reject));
    const request = client.request({
      ":method": "POST",
      ":path": `${url.pathname}${url.search}`,
      ...requestHeaders(token, machineId),
    });
    request.on("response", (headers) => { responseHeaders = headers; });
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.once("end", finish(() => {
      resolve({
        status: Number(responseHeaders?.[":status"] ?? 0),
        headers: responseHeaders,
        body: Buffer.concat(chunks),
      });
    }));
    request.once("error", finish(reject));
    request.end(connectFrame(payload));
  });
}

let MACHINE_ID = "";

async function runRequest(request) {
  const response = await callUnified(request.payload, ACCESS_TOKEN, MACHINE_ID);
  const parsed = parseConnectResponse(response.body);
  if (response.status !== 200) {
    fail(`HTTP_${response.status}`);
  }
  if (parsed.errors.length > 0 && !parsed.text && parsed.toolCalls.length === 0) {
    fail(parsed.errors.join("; "));
  }
  if (!parsed.text && !parsed.reasoning && parsed.toolCalls.length === 0) {
    fail(parsed.field5Diagnostics.length > 0 ? "ACTION_REQUIRED_RESPONSE" : "EMPTY_SUCCESS");
  }
  return parsed;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const payload = Buffer.from(data);
  const chunk = Buffer.alloc(12 + payload.length);
  chunk.writeUInt32BE(payload.length, 0);
  typeBytes.copy(chunk, 4);
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(concat(typeBytes, payload)), 8 + payload.length);
  return chunk;
}

function makeRedBluePng(width = 256, height = 128) {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const scanline = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    const offset = 1 + x * 3;
    if (x < width / 2) scanline.set([255, 0, 0], offset);
    else scanline.set([0, 0, 255], offset);
  }
  const pixels = Buffer.concat(Array.from({ length: height }, () => scanline));
  return concat(
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  );
}

function concise(value, max = 300) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function reasoningDiagnostic(value, suffixMax = 160) {
  const text = String(value ?? "");
  const marker = "</think>";
  const closingTags = text.split(marker).length - 1;
  const markerIndex = text.lastIndexOf(marker);
  return JSON.stringify({
    characters: text.length,
    closingTags,
    suffix: markerIndex >= 0 ? concise(text.slice(markerIndex + marker.length), suffixMax) : "",
    preview: concise(text, 160),
  });
}

async function probeText() {
  const response = await runRequest(encodeUnifiedRequest({
    messages: [{ role: ROLE.USER, text: "Reply with exactly UNIFIED_TEXT_OK and nothing else." }],
  }));
  const passed = response.text.trim() === "UNIFIED_TEXT_OK";
  const diagnostics = passed
    ? ""
    : ` reasoning=${reasoningDiagnostic(response.reasoning)} unknownOuterFields=${JSON.stringify([...response.unknownOuterFields])} field5=${JSON.stringify(response.field5Diagnostics)} errors=${JSON.stringify(response.errors)}`;
  console.log(`[text] ${passed ? "PASS" : "FAIL"} response=${JSON.stringify(concise(response.text))}${diagnostics}`);
  return passed;
}

async function probeImage() {
  const width = 256;
  const height = 128;
  const response = await runRequest(encodeUnifiedRequest({
    messages: [{
      role: ROLE.USER,
      text: "Inspect the attached image. It is split into two equal vertical color panels. Reply exactly IMAGE_OK:<left-color>:<right-color>.",
      images: [{ data: makeRedBluePng(width, height), width, height, uuid: randomUUID() }],
    }],
  }));
  const normalized = response.text.toLowerCase().replace(/\s+/g, "");
  const passed =
    normalized.includes("image_ok:red:blue") ||
    normalized.includes("image_ok:#ff0000:#0000ff");
  const diagnostics = passed ? "" : ` reasoning=${reasoningDiagnostic(response.reasoning)}`;
  console.log(`[image] ${passed ? "PASS" : "FAIL"} response=${JSON.stringify(concise(response.text))}${diagnostics}`);
  return passed;
}

async function probeHistoryReplay() {
  const nonce = `history-${randomUUID().slice(0, 8)}`;
  const firstPrompt = `Remember the token ${nonce}. Reply exactly HISTORY_ACK.`;
  const first = await runRequest(encodeUnifiedRequest({
    messages: [{ role: ROLE.USER, text: firstPrompt }],
  }));
  if (first.text.trim() !== "HISTORY_ACK") {
    console.log(`[history-first] FAIL response=${JSON.stringify(concise(first.text))} reasoning=${reasoningDiagnostic(first.reasoning)}`);
    return false;
  }

  const second = await runRequest(encodeUnifiedRequest({
    conversationId: randomUUID(),
    messages: [
      { role: ROLE.USER, text: firstPrompt },
      { role: ROLE.ASSISTANT, text: "HISTORY_ACK" },
      { role: ROLE.USER, text: "Reply exactly HISTORY_OK:<remembered-token>." },
    ],
  }));
  const expected = `HISTORY_OK:${nonce}`;
  const passed = second.text.replace(/\s+/g, "").includes(expected);
  const diagnostics = passed ? "" : ` reasoning=${reasoningDiagnostic(second.reasoning)}`;
  console.log(`[history-replay] ${passed ? "PASS" : "FAIL"} response=${JSON.stringify(concise(second.text))}${diagnostics}`);
  return passed;
}

async function probeToolReplay() {
  const inputNonce = randomUUID().slice(0, 8);
  const resultNonce = `result-${randomUUID().slice(0, 8)}`;
  const serverName = process.env.CURSOR_PROBE_TOOL_SERVER ?? "opencode-probe";
  const toolName = process.env.CURSOR_PROBE_TOOL_NAME ?? "probe_echo";
  const fullToolName = `${serverName}-${toolName}`;
  const tool = {
    name: fullToolName,
    toolName,
    serverName,
    description: "Diagnostic echo tool. Call it exactly when the user requests this probe.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  };
  const prompt = `Call the ${toolName} tool from the ${serverName} MCP server with text "${inputNonce}". Do not answer before calling it. After receiving its result, reply exactly TOOL_REPLAY_OK:<returned-value>.`;
  const initialConversationId = randomUUID();
  const first = await runRequest(encodeUnifiedRequest({
    conversationId: initialConversationId,
    messages: [{ role: ROLE.USER, text: prompt }],
    tools: [tool],
  }));
  const call = first.toolCalls.find((candidate) => candidate.toolName === toolName);
  if (!call) {
    console.log(`[tool] FAIL no tool call; text=${JSON.stringify(concise(first.text))} reasoning=${reasoningDiagnostic(first.reasoning, 1_000)}`);
    return false;
  }
  let parsedArgs;
  try {
    parsedArgs = JSON.parse(call.rawArgs);
  } catch {
    console.log(`[tool] FAIL malformed arguments=${JSON.stringify(concise(call.rawArgs))}`);
    return false;
  }
  const argsPassed = parsedArgs?.text === inputNonce;
  console.log(`[tool-call] ${argsPassed ? "PASS" : "FAIL"} name=${call.toolName} index=${call.toolIndex} args=${JSON.stringify(parsedArgs)} trailerErrors=${JSON.stringify(first.errors)}`);
  if (!argsPassed) return false;

  // Use a new conversation ID as well as a new HTTP/2 connection. If this
  // succeeds, continuation came from the replayed history rather than a live
  // stream or server-side conversation keyed by the initial ID.
  const replayConversationId = randomUUID();
  const second = await runRequest(encodeUnifiedRequest({
    conversationId: replayConversationId,
    messages: [
      { role: ROLE.USER, text: prompt },
      { role: ROLE.ASSISTANT, text: "", toolResults: [{ call, result: resultNonce }] },
      { role: ROLE.USER, text: "" },
    ],
    tools: [tool],
  }));
  const expected = `TOOL_REPLAY_OK:${resultNonce}`;
  const passed = second.text.replace(/\s+/g, "").includes(expected);
  const diagnostics = passed ? "" : ` reasoning=${reasoningDiagnostic(second.reasoning)}`;
  console.log(`[tool-replay] ${passed ? "PASS" : "FAIL"} response=${JSON.stringify(concise(second.text))}${diagnostics}`);
  return passed;
}

export { callUnified, connectFrame, encodeUnifiedRequest, makeRedBluePng };

async function main() {
  if (!ACCESS_TOKEN) {
    console.error("CURSOR_ACCESS_TOKEN is required. The probe did not contact Cursor.");
    process.exitCode = 2;
    return;
  }
  MACHINE_ID = process.env.CURSOR_MACHINE_ID || sha256(`${ACCESS_TOKEN}machineId`);
  const tokenKind = ACCESS_TOKEN.split(".").length === 3 ? "jwt" : "api-key";
  console.log(
    `UnifiedChat probe endpoint=${new URL(ENDPOINT).host} model=${MODEL} stage=${STAGE} maxMode=${MAX_MODE ? "on" : "off"} ` +
      `token=${tokenKind} machineId=${process.env.CURSOR_MACHINE_ID ? "provided" : "derived"}`,
  );
  const selected = STAGE === "all" ? ["text", "image", "history", "tool"] : [STAGE.toLowerCase()];
  const results = [];
  try {
    for (const stage of selected) {
      if (stage === "text") results.push(await probeText());
      else if (stage === "image") results.push(await probeImage());
      else if (stage === "history") results.push(await probeHistoryReplay());
      else if (stage === "tool") results.push(await probeToolReplay());
      else fail(`Unknown CURSOR_PROBE_STAGE: ${STAGE}`);
    }
  } catch (error) {
    console.error(`[probe] ERROR ${error.message}`);
    process.exitCode = 1;
  }
  if (results.length > 0 && results.every(Boolean)) {
    console.log("UnifiedChat capability probe PASSED.");
  } else if (results.length > 0) {
    console.error("UnifiedChat capability probe FAILED.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
