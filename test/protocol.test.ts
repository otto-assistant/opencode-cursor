import { gzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import {
  UNIFIED_CHAT_LIMITS,
  UNIFIED_CHAT_PATH,
  UnifiedChatResponseDecoder,
  encodeUnifiedChatRequest,
  type UnifiedChatEvent,
  type UnifiedChatRequest,
} from "../src/unified-chat-protocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Field {
  number: number;
  wire: number;
  value: bigint | Uint8Array;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function varint(value: number | bigint): Uint8Array {
  let remaining = BigInt(value);
  const bytes: number[] = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0n);
  return Uint8Array.from(bytes);
}

function tag(number: number, wire: number): Uint8Array {
  return varint((BigInt(number) << 3n) | BigInt(wire));
}

function v(number: number, value: number | bigint): Uint8Array {
  return concat(tag(number, 0), varint(value));
}

function b(number: number, value: string | Uint8Array): Uint8Array {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return concat(tag(number, 2), varint(bytes.byteLength), bytes);
}

function m(number: number, ...parts: readonly Uint8Array[]): Uint8Array {
  return b(number, concat(...parts));
}

function fixed(number: number, wire: 1 | 5): Uint8Array {
  return concat(tag(number, wire), new Uint8Array(wire === 1 ? 8 : 4));
}

function protoValue(value: JsonValue): Uint8Array {
  if (value === null) return v(1, 0);
  if (typeof value === "number") {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    return concat(tag(2, 1), bytes);
  }
  if (typeof value === "string") return b(3, value);
  if (typeof value === "boolean") return v(4, value ? 1 : 0);
  if (Array.isArray(value)) return m(6, ...value.map((item) => m(1, protoValue(item))));
  return m(5, protoStruct(value));
}

function protoStruct(value: { readonly [key: string]: JsonValue }): Uint8Array {
  return concat(...Object.entries(value).map(([key, item]) => m(1, b(1, key), m(2, protoValue(item)))));
}

function readVarint(input: Uint8Array, start: number): { value: bigint; offset: number } {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < input.byteLength) {
    const byte = input[offset];
    if (byte === undefined) throw new Error("truncated varint");
    offset++;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7n;
  }
  throw new Error("truncated varint");
}

function fields(input: Uint8Array): Field[] {
  const result: Field[] = [];
  let offset = 0;
  while (offset < input.byteLength) {
    const parsedTag = readVarint(input, offset);
    offset = parsedTag.offset;
    const number = Number(parsedTag.value >> 3n);
    const wire = Number(parsedTag.value & 7n);
    if (wire === 0) {
      const parsed = readVarint(input, offset);
      offset = parsed.offset;
      result.push({ number, wire, value: parsed.value });
      continue;
    }
    if (wire === 1 || wire === 5) {
      const length = wire === 1 ? 8 : 4;
      const end = offset + length;
      if (end > input.byteLength) throw new Error("truncated fixed field");
      result.push({ number, wire, value: input.subarray(offset, end) });
      offset = end;
      continue;
    }
    if (wire !== 2) throw new Error(`unsupported wire type ${wire}`);
    const parsedLength = readVarint(input, offset);
    offset = parsedLength.offset;
    const length = Number(parsedLength.value);
    const end = offset + length;
    if (end > input.byteLength) throw new Error("truncated bytes field");
    result.push({ number, wire, value: input.subarray(offset, end) });
    offset = end;
  }
  return result;
}

function bytes(items: readonly Field[], number: number, index = 0): Uint8Array {
  const field = items.filter((item) => item.number === number && item.wire === 2)[index];
  if (!field || typeof field.value === "bigint") throw new Error(`missing bytes field ${number}`);
  return field.value;
}

function allBytes(items: readonly Field[], number: number): Uint8Array[] {
  return items
    .filter((item) => item.number === number && item.wire === 2)
    .map((item) => {
      if (typeof item.value === "bigint") throw new Error(`invalid bytes field ${number}`);
      return item.value;
    });
}

function number(items: readonly Field[], fieldNumber: number): number {
  const field = items.find((item) => item.number === fieldNumber && item.wire === 0);
  if (!field || typeof field.value !== "bigint") throw new Error(`missing number field ${fieldNumber}`);
  return Number(field.value);
}

function text(value: Uint8Array): string {
  return decoder.decode(value);
}

function itemAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`missing item ${index}`);
  return item;
}

function decodeProtoValue(input: Uint8Array): JsonValue {
  const valueFields = fields(input);
  if (valueFields.some((field) => field.number === 1 && field.wire === 0)) return null;
  const double = valueFields.find((field) => field.number === 2 && field.wire === 1);
  if (double && double.value instanceof Uint8Array) {
    return new DataView(double.value.buffer, double.value.byteOffset, 8).getFloat64(0, true);
  }
  const string = valueFields.find((field) => field.number === 3 && field.wire === 2);
  if (string && string.value instanceof Uint8Array) return text(string.value);
  const boolean = valueFields.find((field) => field.number === 4 && field.wire === 0);
  if (boolean && typeof boolean.value === "bigint") return boolean.value !== 0n;
  const object = valueFields.find((field) => field.number === 5 && field.wire === 2);
  if (object && object.value instanceof Uint8Array) return decodeProtoStruct(object.value);
  const list = valueFields.find((field) => field.number === 6 && field.wire === 2);
  if (list && list.value instanceof Uint8Array) {
    return allBytes(fields(list.value), 1).map(decodeProtoValue);
  }
  throw new Error("invalid protobuf value");
}

function decodeProtoStruct(input: Uint8Array): { [key: string]: JsonValue } {
  return Object.fromEntries(allBytes(fields(input), 1).map((entryBytes) => {
    const entry = fields(entryBytes);
    return [text(bytes(entry, 1)), decodeProtoValue(bytes(entry, 2))];
  }));
}

function frame(payload: Uint8Array, flags = 0): Uint8Array {
  const result = new Uint8Array(5 + payload.byteLength);
  result[0] = flags;
  new DataView(result.buffer).setUint32(1, payload.byteLength, false);
  result.set(payload, 5);
  return result;
}

function responseText(value: string): Uint8Array {
  return m(2, b(1, value));
}

function responseReasoning(value: string): Uint8Array {
  return m(2, m(25, b(1, value)));
}

interface CallFixture {
  id: string;
  name?: string;
  serverName?: string;
  wireName?: string;
  arguments?: { readonly [key: string]: JsonValue } | string;
  index?: number;
  modelCallId?: string;
  isLast?: boolean;
  alternate?: boolean;
}

function responseCall(call: CallFixture): Uint8Array {
  const raw = typeof call.arguments === "string"
    ? call.arguments
    : JSON.stringify(call.arguments ?? {});
  const toolName = call.name ?? "";
  const serverName = call.serverName ?? "opencode";
  const params = call.alternate
    ? m(27, m(1, b(1, `opencode-${toolName}`), b(3, raw), b(4, serverName)))
    : m(62, b(1, serverName), b(2, toolName),
      typeof call.arguments === "string" ? new Uint8Array() : m(3, protoStruct(call.arguments ?? {})));
  return m(1,
    v(1, 49),
    params,
    b(3, call.id),
    toolName ? b(9, call.wireName ?? `opencode-${toolName}`) : new Uint8Array(),
    raw ? b(10, raw) : new Uint8Array(),
    call.isLast ? v(15, 1) : new Uint8Array(),
    call.index === undefined ? new Uint8Array() : v(48, call.index + 1),
    call.modelCallId ? b(49, call.modelCallId) : new Uint8Array(),
  );
}

function baseRequest(overrides: Partial<UnifiedChatRequest> = {}): UnifiedChatRequest {
  return {
    system: "System fixture",
    model: "test-model",
    messages: [{ role: "user", text: "Hello" }],
    ...overrides,
  };
}

function nestedObject(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = {};
  for (let index = 0; index < depth; index += 1) value = { child: value };
  return value;
}

function collect(decoderInstance: UnifiedChatResponseDecoder, chunks: readonly Uint8Array[]): UnifiedChatEvent[] {
  return [...chunks.flatMap((chunk) => decoderInstance.push(chunk)), ...decoderInstance.finish()];
}

describe("encodeUnifiedChatRequest", () => {
  test("encodes the proven system, history, image, tool, and typed-result fields", () => {
    const request = baseRequest({
      maxMode: true,
      tools: [{
        name: "read_file",
        description: "Read a fixture file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      }],
      messages: [
        {
          role: "user",
          text: "Inspect this",
          images: [{
            data: Uint8Array.of(1, 2, 3),
            width: 2,
            height: 3,
            uuid: "123e4567-e89b-42d3-a456-426614174000",
          }],
        },
        {
          role: "assistant",
          text: "",
          toolResults: [{
            call: {
              id: "call-1",
              name: "read_file",
              index: 0,
              arguments: "{\"path\":\"fixture.txt\"}",
              modelCallId: "model-call-1",
            },
            result: "fixture result",
          }],
        },
        { role: "user", text: "Continue" },
      ],
    });

    const encoded = encodeUnifiedChatRequest(request);
    expect(UNIFIED_CHAT_PATH).toBe("/aiserver.v1.ChatService/StreamUnifiedChatWithTools");
    expect(encoded[0]).toBe(0);
    expect(new DataView(encoded.buffer, encoded.byteOffset).getUint32(1, false)).toBe(encoded.byteLength - 5);

    const envelope = fields(encoded.subarray(5));
    const root = fields(bytes(envelope, 1));
    expect(text(bytes(fields(bytes(root, 3)), 1))).toBe("System fixture");
    const model = fields(bytes(root, 5));
    expect(text(bytes(model, 1))).toBe("test-model");
    expect(number(model, 8)).toBe(1);
    expect(text(bytes(root, 23))).toMatch(/^[0-9a-f-]{36}$/);

    const messages = allBytes(root, 1).map(fields);
    expect(messages).toHaveLength(3);
    const firstMessage = itemAt(messages, 0);
    const secondMessage = itemAt(messages, 1);
    expect(text(bytes(firstMessage, 1))).toBe("Inspect this");
    expect(number(firstMessage, 2)).toBe(1);
    const image = fields(bytes(firstMessage, 10));
    expect(bytes(image, 1)).toEqual(Uint8Array.of(1, 2, 3));
    const dimensions = fields(bytes(image, 2));
    expect([number(dimensions, 1), number(dimensions, 2)]).toEqual([2, 3]);
    expect(text(bytes(image, 3))).toBe("123e4567-e89b-42d3-a456-426614174000");

    const descriptor = fields(bytes(firstMessage, 83));
    expect(text(bytes(descriptor, 1))).toBe("opencode");
    expect(text(bytes(descriptor, 2))).toBe("opencode");
    const descriptorTool = fields(bytes(descriptor, 5));
    expect(text(bytes(descriptorTool, 1))).toBe("read_file");
    expect(decodeProtoStruct(bytes(descriptorTool, 4))).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    });

    expect(number(secondMessage, 2)).toBe(2);
    const replay = fields(bytes(secondMessage, 18));
    expect(text(bytes(replay, 1))).toBe("call-1");
    expect(text(bytes(replay, 2))).toBe("opencode-read_file");
    expect(number(replay, 3)).toBe(1);
    expect(text(bytes(replay, 4))).toBe("{\"path\":\"fixture.txt\"}");
    expect(text(bytes(replay, 7))).toBe("fixture result");
    expect(text(bytes(replay, 12))).toBe("model-call-1");

    const clientCall = fields(bytes(replay, 11));
    expect(number(clientCall, 1)).toBe(49);
    expect(text(bytes(clientCall, 3))).toBe("call-1");
    expect(text(bytes(clientCall, 9))).toBe("opencode-read_file");
    expect(number(clientCall, 15)).toBe(1);
    expect(number(clientCall, 48)).toBe(1);
    const callParams = fields(bytes(clientCall, 62));
    expect(text(bytes(callParams, 1))).toBe("opencode");
    expect(text(bytes(callParams, 2))).toBe("read_file");
    expect(decodeProtoStruct(bytes(callParams, 3))).toEqual({ path: "fixture.txt" });

    const clientResult = fields(bytes(replay, 8));
    expect(number(clientResult, 1)).toBe(49);
    expect(text(bytes(clientResult, 35))).toBe("call-1");
    expect(number(clientResult, 49)).toBe(1);
    const resultParams = fields(bytes(clientResult, 62));
    expect(decodeProtoStruct(bytes(resultParams, 3))).toEqual({
      content: [{ type: "text", text: "fixture result" }],
      isError: false,
    });

    const tool = fields(bytes(root, 34));
    expect(text(bytes(tool, 1))).toBe("opencode-read_file");
    expect(text(bytes(tool, 4))).toBe("opencode");
    expect(JSON.parse(text(bytes(tool, 3)))).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    });
  });

  test("generates a fresh conversation UUID for every encode", () => {
    const first = fields(bytes(fields(encodeUnifiedChatRequest(baseRequest()).subarray(5)), 1));
    const second = fields(bytes(fields(encodeUnifiedChatRequest(baseRequest()).subarray(5)), 1));
    const firstId = text(bytes(first, 23));
    const secondId = text(bytes(second, 23));
    expect(firstId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(secondId).not.toBe(firstId);
  });

  test("validates model, duplicate names and calls, JSON objects, UUIDs, and dimensions", () => {
    expect(() => encodeUnifiedChatRequest(baseRequest({ model: "  " }))).toThrow(/model/i);
    expect(() => encodeUnifiedChatRequest(baseRequest({
      tools: [
        { name: "same", parameters: {} },
        { name: "same", parameters: {} },
      ],
    }))).toThrow(/duplicate tool/i);
    expect(() => encodeUnifiedChatRequest(baseRequest({
      tools: [{ name: "tool", parameters: {} }],
      messages: [{
        role: "assistant",
        toolResults: [
          { call: { id: "same", name: "tool", index: 0, arguments: "{}" }, result: "one" },
          { call: { id: "same", name: "tool", index: 1, arguments: "{}" }, result: "two" },
        ],
      }],
    }))).toThrow(/duplicate tool call/i);
    expect(() => encodeUnifiedChatRequest(baseRequest({
      tools: [{ name: "tool", parameters: [] as unknown as Record<string, unknown> }],
    }))).toThrow(/schema.*object/i);
    expect(() => encodeUnifiedChatRequest(baseRequest({
      tools: [{ name: "tool", parameters: {} }],
      messages: [{
        role: "assistant",
        toolResults: [{
          call: { id: "call", name: "tool", index: 0, arguments: "[]" },
          result: "result",
        }],
      }],
    }))).toThrow(/arguments.*object/i);
    expect(() => encodeUnifiedChatRequest(baseRequest({
      messages: [{
        role: "user",
        images: [{ data: Uint8Array.of(1), width: 1, height: 1, uuid: "not-a-uuid" }],
      }],
    }))).toThrow(/UUID/i);
    expect(() => encodeUnifiedChatRequest(baseRequest({
      messages: [{ role: "user", images: [{ data: Uint8Array.of(1), width: 0, height: 1 }] }],
    }))).toThrow(/dimensions/i);
  });

  test("enforces message, tool-schema, image, and final-frame bounds", () => {
    expect(() => encodeUnifiedChatRequest(baseRequest({
      messages: Array.from({ length: UNIFIED_CHAT_LIMITS.maxMessages + 1 }, () => ({
        role: "user" as const,
        text: "x",
      })),
    }))).toThrow(/messages/i);
    expect(() => encodeUnifiedChatRequest(baseRequest({
      tools: Array.from({ length: UNIFIED_CHAT_LIMITS.maxTools + 1 }, (_, index) => ({
        name: `tool-${index}`,
        parameters: {},
      })),
    }))).toThrow(/tools/i);
    expect(() => encodeUnifiedChatRequest(baseRequest({
      tools: [{
        name: "large",
        parameters: { value: "x".repeat(UNIFIED_CHAT_LIMITS.maxToolSchemaBytes) },
      }],
    }))).toThrow(/schema/i);
    const sharedSchemaValue = "x".repeat(900_000);
    expect(() => encodeUnifiedChatRequest(baseRequest({
      tools: Array.from({ length: 5 }, (_, index) => ({
        name: `schema-${index}`,
        parameters: { value: sharedSchemaValue },
      })),
    }))).toThrow(/schema.*total/i);
    expect(() => encodeUnifiedChatRequest(baseRequest({
      messages: [{
        role: "user",
        images: Array.from({ length: UNIFIED_CHAT_LIMITS.maxImages + 1 }, () => ({
          data: Uint8Array.of(1), width: 1, height: 1,
        })),
      }],
    }))).toThrow(/images/i);
    expect(() => encodeUnifiedChatRequest(baseRequest({
      messages: [{ role: "user", images: [{
        data: new Uint8Array(UNIFIED_CHAT_LIMITS.maxImageBytes + 1), width: 1, height: 1,
      }] }],
    }))).toThrow(/image.*bytes/i);
    const largeImage = new Uint8Array(7 * 1024 * 1024);
    expect(() => encodeUnifiedChatRequest(baseRequest({
      messages: [{
        role: "user",
        images: Array.from({ length: 3 }, () => ({ data: largeImage, width: 1, height: 1 })),
      }],
    }))).toThrow(/image.*total/i);
    expect(() => encodeUnifiedChatRequest(baseRequest({
      system: "x".repeat(UNIFIED_CHAT_LIMITS.maxFrameBytes),
    }))).toThrow(/frame/i);
    expect(() => encodeUnifiedChatRequest(baseRequest({
      messages: Array.from({ length: UNIFIED_CHAT_LIMITS.maxMessages }, () => ({
        role: "user" as const,
        text: "x",
      })),
      tools: [{ name: "expanded", parameters: { value: "x".repeat(300_000) } }],
    }))).toThrow(/descriptors.*frame/i);
    expect(() => encodeUnifiedChatRequest(baseRequest({
      tools: [{
        name: "numeric-enum",
        parameters: { enum: Array.from({ length: 20_001 }, (_, index) => index) },
      }],
    }))).toThrow(/complexity/i);
  });

  test("rejects aggregate tool replay content before repeated wire encoding", () => {
    expect(() => encodeUnifiedChatRequest(baseRequest({
      tools: [{ name: "large-result", parameters: {} }],
      messages: [{
        role: "assistant",
        toolResults: Array.from({ length: 2 }, (_, index) => ({
          call: {
            id: `call-${index}`,
            name: "large-result",
            index,
            arguments: "{}",
          },
          result: "x".repeat(UNIFIED_CHAT_LIMITS.maxToolReplayBytes / 2),
        })),
      }],
    }))).toThrow(/tool replay.*limit/i);
  });

  test("rejects oversized tool arguments before parsing", () => {
    const argumentsValue = JSON.stringify({
      value: "x".repeat(UNIFIED_CHAT_LIMITS.maxToolArgumentsBytes),
    });
    expect(() => encodeUnifiedChatRequest(baseRequest({
      tools: [{ name: "large-arguments", parameters: {} }],
      messages: [{
        role: "assistant",
        toolResults: [{
          call: {
            id: "call-1",
            name: "large-arguments",
            index: 0,
            arguments: argumentsValue,
          },
          result: "ok",
        }],
      }],
    }))).toThrow(/tool arguments.*limit/i);
  });

  test("rejects compact replay arguments whose exact protobuf expansion exceeds the limit", () => {
    const argumentsValue = JSON.stringify({
      values: Array.from({ length: 10_000 }, () => 0),
    });
    expect(() => encodeUnifiedChatRequest(baseRequest({
      tools: [{ name: "numeric-arguments", parameters: {} }],
      messages: Array.from({ length: 64 }, (_, index) => ({
        role: "assistant" as const,
        toolResults: [{
          call: {
            id: `call-${index}`,
            name: "numeric-arguments",
            index,
            arguments: argumentsValue,
          },
          result: "ok",
        }],
      })),
    }))).toThrow(/encoded tool replay.*limit/i);
  });

  test("accepts tool schema and replay argument nesting at the 64-level limit", () => {
    expect(() => encodeUnifiedChatRequest(baseRequest({
      tools: [{ name: "nested-schema", parameters: nestedObject(64) }],
    }))).not.toThrow();
    expect(() => encodeUnifiedChatRequest(baseRequest({
      messages: [{
        role: "assistant",
        toolResults: [{
          call: {
            id: "call-1",
            name: "nested-arguments",
            index: 0,
            arguments: JSON.stringify(nestedObject(64)),
          },
          result: "ok",
        }],
      }],
    }))).not.toThrow();
  });

  test("rejects tool schema and replay argument nesting above 64 levels", () => {
    expect(() => encodeUnifiedChatRequest(baseRequest({
      tools: [{ name: "nested-schema", parameters: nestedObject(65) }],
    }))).toThrow(/nesting.*limit/i);
    expect(() => encodeUnifiedChatRequest(baseRequest({
      messages: [{
        role: "assistant",
        toolResults: [{
          call: {
            id: "call-1",
            name: "nested-arguments",
            index: 0,
            arguments: JSON.stringify(nestedObject(65)),
          },
          result: "ok",
        }],
      }],
    }))).toThrow(/nesting.*limit/i);
  });
});

describe("UnifiedChatResponseDecoder", () => {
  test("decodes text and reasoning", () => {
    const instance = new UnifiedChatResponseDecoder();
    expect(instance.push(frame(concat(responseText("Hello"), responseReasoning("Think"))))).toEqual([
      { type: "text", text: "Hello" },
      { type: "reasoning", text: "Think" },
    ]);
    expect(instance.finish()).toEqual([{ type: "end" }]);
  });

  test("emits one direct call on explicit isLast", () => {
    const instance = new UnifiedChatResponseDecoder();
    expect(instance.push(frame(responseCall({
      id: "call-1",
      name: "read_file",
      arguments: { path: "fixture.txt" },
      index: 0,
      modelCallId: "model-1",
      isLast: true,
    })))).toEqual([]);
    expect(instance.finish()).toEqual([
      {
        type: "tool-call",
        call: {
          id: "call-1",
          name: "read_file",
          arguments: "{\"path\":\"fixture.txt\"}",
          index: 0,
          modelCallId: "model-1",
        },
      },
      { type: "end" },
    ]);
  });

  test("prefers the authoritative MCP name over a different internal wire label", () => {
    const payload = m(1,
      v(1, 49),
      m(62, b(1, "unknown"), b(2, "read_file"), m(3, protoStruct({ path: "fixture.txt" }))),
      b(3, "call-1"),
      b(9, "call_mcp_tool"),
      v(15, 1),
      v(48, 1),
    );
    expect(collect(new UnifiedChatResponseDecoder(), [frame(payload)])).toEqual([
      {
        type: "tool-call",
        call: {
          id: "call-1",
          name: "read_file",
          arguments: "{\"path\":\"fixture.txt\"}",
          index: 0,
          serverName: "unknown",
          wireName: "call_mcp_tool",
        },
      },
      { type: "end" },
    ]);
  });

  test("sorts parallel direct and alternate calls at finish", () => {
    const events = collect(new UnifiedChatResponseDecoder(), [frame(concat(
      responseCall({ id: "call-2", name: "write", arguments: { value: 2 }, index: 2 }),
      responseCall({ id: "call-1", name: "read", arguments: { value: 1 }, index: 1, alternate: true }),
    ))]);
    expect(events).toEqual([
      { type: "tool-call", call: { id: "call-1", name: "read", arguments: "{\"value\":1}", index: 1 } },
      { type: "tool-call", call: { id: "call-2", name: "write", arguments: "{\"value\":2}", index: 2 } },
      { type: "end" },
    ]);
  });

  test("replaces prefix/full snapshots and emits duplicate finals once", () => {
    const instance = new UnifiedChatResponseDecoder();
    expect(instance.push(frame(responseCall({
      id: "call-1", name: "search", arguments: "{\"query\":", index: 0,
    })))).toEqual([]);
    const complete = frame(responseCall({
      id: "call-1", name: "search", arguments: { query: "fixture" }, index: 0, isLast: true,
    }));
    expect(instance.push(complete)).toEqual([]);
    expect(instance.push(complete)).toEqual([]);
    expect(instance.finish()).toEqual([
      {
        type: "tool-call",
        call: { id: "call-1", name: "search", arguments: "{\"query\":\"fixture\"}", index: 0 },
      },
      { type: "end" },
    ]);
  });

  test("rejects divergent full snapshots rather than concatenating JSON", () => {
    const instance = new UnifiedChatResponseDecoder();
    expect(instance.push(frame(responseCall({ id: "call-1", name: "search", arguments: { query: "one" } })))).toEqual([]);
    expect(instance.push(frame(responseCall({ id: "call-1", name: "search", arguments: { query: "two" } })))).toEqual([{
      type: "error",
      code: "protocol_error",
      message: "Divergent tool call snapshots",
      retryable: false,
    }]);
    expect(instance.finish()).toEqual([]);
  });

  test("handles every byte boundary and multiple frames", () => {
    const input = concat(frame(responseText("A")), frame(responseReasoning("B")));
    const instance = new UnifiedChatResponseDecoder();
    const events: UnifiedChatEvent[] = [];
    for (const byte of input) events.push(...instance.push(Uint8Array.of(byte)));
    events.push(...instance.finish());
    expect(events).toEqual([
      { type: "text", text: "A" },
      { type: "reasoning", text: "B" },
      { type: "end" },
    ]);
  });

  test("decompresses gzip data frames", () => {
    const compressed = gzipSync(responseText("compressed"));
    expect(collect(new UnifiedChatResponseDecoder(), [frame(compressed, 1)])).toEqual([
      { type: "text", text: "compressed" },
      { type: "end" },
    ]);
  });

  test("decodes structured end-stream errors without exposing trailer details", () => {
    const trailer = frame(encoder.encode(JSON.stringify({
      error: {
        code: "unavailable",
        message: "Service temporarily unavailable",
        details: [{ private: "must not appear" }],
      },
    })), 2);
    const instance = new UnifiedChatResponseDecoder();
    expect(instance.push(trailer)).toEqual([{
      type: "error",
      code: "unavailable",
      message: "Service temporarily unavailable",
      retryable: true,
    }]);
    expect(instance.finish()).toEqual([]);
  });

  test("treats Cursor aborted trailers as a normal completed tool handoff", () => {
    const instance = new UnifiedChatResponseDecoder();
    expect(instance.push(frame(responseCall({
      id: "call-1",
      name: "read_file",
      arguments: { path: "fixture.txt" },
      index: 0,
    })))).toEqual([]);
    expect(instance.push(frame(encoder.encode(JSON.stringify({
      error: { code: "aborted", message: "Error" },
    })), 2))).toEqual([]);
    expect(instance.finish()).toEqual([
      {
        type: "tool-call",
        call: {
          id: "call-1",
          name: "read_file",
          arguments: "{\"path\":\"fixture.txt\"}",
          index: 0,
        },
      },
      { type: "end" },
    ]);
  });

  test("accepts a direct tool call that repeats its name as the namespace", () => {
    expect(collect(new UnifiedChatResponseDecoder(), [frame(responseCall({
      id: "call-1",
      name: "bash",
      serverName: "bash",
      wireName: "call_mcp_tool",
      arguments: { command: "pwd" },
      index: 0,
    }))])).toEqual([
      {
        type: "tool-call",
        call: {
          id: "call-1",
          name: "bash",
          arguments: "{\"command\":\"pwd\"}",
          index: 0,
          serverName: "bash",
          wireName: "call_mcp_tool",
        },
      },
      { type: "end" },
    ]);
  });

  test("rejects a direct tool call from an unrelated namespace", () => {
    expect(collect(new UnifiedChatResponseDecoder(), [frame(responseCall({
      id: "call-1",
      name: "bash",
      serverName: "unrelated",
      arguments: { command: "pwd" },
    }))])).toEqual([{
      type: "error",
      code: "protocol_error",
      message: "Unexpected tool call namespace",
      retryable: false,
    }]);
  });

  test("ignores unknown protobuf fields, including groups", () => {
    const unknownGroup = concat(tag(90, 3), v(1, 7), tag(90, 4));
    const payload = concat(
      v(80, 1),
      fixed(81, 1),
      fixed(82, 5),
      b(83, "unknown"),
      unknownGroup,
      m(2, v(70, 1), b(1, "known")),
    );
    expect(collect(new UnifiedChatResponseDecoder(), [frame(payload)])).toEqual([
      { type: "text", text: "known" },
      { type: "end" },
    ]);
  });

  test("rejects malformed, truncated, oversized, and unsupported frames", () => {
    const malformed = new UnifiedChatResponseDecoder();
    expect(malformed.push(frame(concat(tag(2, 2), varint(10), Uint8Array.of(1))))[0]).toMatchObject({
      type: "error", code: "protocol_error", retryable: false,
    });

    const truncated = new UnifiedChatResponseDecoder();
    truncated.push(frame(responseText("cut")).subarray(0, 7));
    expect(truncated.finish()).toEqual([{
      type: "error", code: "protocol_error", message: "Truncated Connect frame", retryable: false,
    }]);

    const oversizedHeader = new Uint8Array(5);
    new DataView(oversizedHeader.buffer).setUint32(1, UNIFIED_CHAT_LIMITS.maxFrameBytes + 1, false);
    expect(new UnifiedChatResponseDecoder().push(oversizedHeader)).toEqual([{
      type: "error", code: "protocol_error", message: "Connect frame exceeds limit", retryable: false,
    }]);

    const oversizedResponseHeader = new Uint8Array(5);
    new DataView(oversizedResponseHeader.buffer).setUint32(1, UNIFIED_CHAT_LIMITS.maxFrameBytes, false);
    expect(new UnifiedChatResponseDecoder().push(oversizedResponseHeader)).toEqual([{
      type: "error", code: "protocol_error", message: "UnifiedChat response exceeds limit", retryable: false,
    }]);

    expect(new UnifiedChatResponseDecoder().push(Uint8Array.of(4, 0, 0, 0, 0))).toEqual([{
      type: "error", code: "protocol_error", message: "Unsupported Connect frame flags", retryable: false,
    }]);
    expect(new UnifiedChatResponseDecoder().push(frame(Uint8Array.of(1, 2, 3), 1))).toEqual([{
      type: "error", code: "protocol_error", message: "Invalid gzip response frame", retryable: false,
    }]);
  });

  test("enforces the accumulated response limit before buffering", () => {
    const oversized = new Uint8Array(UNIFIED_CHAT_LIMITS.maxResponseBytes + 1);
    expect(new UnifiedChatResponseDecoder().push(oversized)).toEqual([{
      type: "error", code: "protocol_error", message: "UnifiedChat response exceeds limit", retryable: false,
    }]);
  });

  test("rejects empty successful responses", () => {
    expect(new UnifiedChatResponseDecoder().finish()).toEqual([{
      type: "error",
      code: "protocol_error",
      message: "UnifiedChat response was empty",
      retryable: false,
    }]);
  });
});
