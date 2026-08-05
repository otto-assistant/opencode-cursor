import { Buffer } from "node:buffer";
import { describe, expect, test } from "bun:test";
import { makeRedBluePng } from "../scripts/probe-unified-chat.mjs";
import { createCursorFetch } from "../src/cursor-fetch";
import { encodeCursorModelRequest, type CursorModelSelection } from "../src/model-selection";
import { UNIFIED_CHAT_LIMITS, UNIFIED_CHAT_PATH } from "../src/unified-chat-protocol";
import type { CursorModel } from "../src/models";
import type {
  CursorTransport,
  CursorTransportRequest,
  CursorTransportResponse,
} from "../src/unified-chat-transport";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TOKEN = "synthetic-access-token";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Field {
  number: number;
  wire: number;
  value: bigint | Uint8Array;
}

interface CallFixture {
  id: string;
  name: string;
  arguments: { readonly [key: string]: JsonValue } | string;
  index: number;
  isLast?: boolean;
  modelCallId?: string;
  serverName?: string;
  wireName?: string;
}

const defaultSelection: CursorModelSelection = {
  publicId: "claude-4-test",
  modelId: "claude-server-test",
  displayName: "Claude Test",
  parameters: [],
  maxMode: false,
};

const highSelection: CursorModelSelection = {
  publicId: "claude-4-test-high",
  modelId: "claude-server-test",
  displayName: "Claude Test High",
  parameters: [{ id: "reasoning", value: "high" }],
  maxMode: false,
};

const model: CursorModel = {
  id: "claude-test",
  name: "Claude Test",
  reasoning: true,
  contextWindow: 200_000,
  maxTokens: 64_000,
  defaultSelection,
  variants: { high: highSelection },
};

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function varint(input: number | bigint): Uint8Array {
  let value = BigInt(input);
  const bytes: number[] = [];
  do {
    let byte = Number(value & 0x7fn);
    value >>= 7n;
    if (value !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0n);
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

function protoValue(value: JsonValue): Uint8Array {
  if (value === null) return v(1, 0);
  if (typeof value === "string") return b(3, value);
  if (typeof value === "boolean") return v(4, value ? 1 : 0);
  if (typeof value === "number") {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    return concat(tag(2, 1), bytes);
  }
  if (Array.isArray(value)) return m(6, ...value.map((item) => m(1, protoValue(item))));
  return m(5, protoStruct(value));
}

function protoStruct(value: { readonly [key: string]: JsonValue }): Uint8Array {
  return concat(...Object.entries(value).map(([key, item]) => m(1, b(1, key), m(2, protoValue(item)))));
}

function frame(payload: Uint8Array, flags = 0): Uint8Array {
  const output = new Uint8Array(5 + payload.byteLength);
  output[0] = flags;
  new DataView(output.buffer).setUint32(1, payload.byteLength, false);
  output.set(payload, 5);
  return output;
}

function responseText(value: string): Uint8Array {
  return m(2, b(1, value));
}

function responseReasoning(value: string): Uint8Array {
  return m(2, m(25, b(1, value)));
}

function responseCall(call: CallFixture): Uint8Array {
  const raw = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments);
  return m(1,
    v(1, 49),
    m(62, b(1, call.serverName ?? "opencode"), b(2, call.name),
      typeof call.arguments === "string" ? new Uint8Array() : m(3, protoStruct(call.arguments))),
    b(3, call.id),
    b(9, call.wireName ?? `opencode-${call.name}`),
    b(10, raw),
    call.isLast ? v(15, 1) : new Uint8Array(),
    v(48, call.index + 1),
    call.modelCallId ? b(49, call.modelCallId) : new Uint8Array(),
  );
}

function trailerError(code: string, message: string): Uint8Array {
  return frame(encoder.encode(JSON.stringify({ error: { code, message } })), 2);
}

function streamFrom(chunks: readonly Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

function transportResponse(
  chunks: readonly Uint8Array[],
  status = 200,
  onCancel?: () => void,
): CursorTransportResponse {
  return {
    status,
    headers: new Headers({ "content-type": "application/connect+proto" }),
    trailers: Promise.resolve(new Headers()),
    body: streamFrom(chunks, onCancel),
  };
}

class FakeTransport implements CursorTransport {
  readonly requests: CursorTransportRequest[] = [];

  constructor(
    private readonly respond: (
      request: CursorTransportRequest,
      index: number,
    ) => Promise<CursorTransportResponse> | CursorTransportResponse,
  ) {}

  async request(request: CursorTransportRequest): Promise<CursorTransportResponse> {
    this.requests.push(request);
    return this.respond(request, this.requests.length - 1);
  }
}

function makeFetch(
  transport: CursorTransport,
  models: readonly CursorModel[] = [model],
  getAccessToken: () => Promise<string> = async () => TOKEN,
): ReturnType<typeof createCursorFetch> {
  return createCursorFetch({ transport, getModels: () => models, getAccessToken });
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: model.id,
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
    ...overrides,
  };
}

function requestInit(value: Record<string, unknown>, overrides: RequestInit = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
    ...overrides,
  };
}

function wrappedToolCallId(metadata: Record<string, string>): string {
  return `oc_cursor_tool_call_v2_${Buffer.from(
    JSON.stringify(metadata),
    "utf8",
  ).toString("base64url")}`;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected JSON object");
  }
  return value as Record<string, unknown>;
}

function asRecordForTest(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected record fixture");
  return value;
}

function readVarint(input: Uint8Array, start: number): { value: bigint; offset: number } {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < input.byteLength) {
    const byte = input[offset];
    if (byte === undefined) throw new Error("Truncated varint");
    offset += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7n;
  }
  throw new Error("Truncated varint");
}

function fields(input: Uint8Array): Field[] {
  const output: Field[] = [];
  let offset = 0;
  while (offset < input.byteLength) {
    const parsedTag = readVarint(input, offset);
    offset = parsedTag.offset;
    const number = Number(parsedTag.value >> 3n);
    const wire = Number(parsedTag.value & 7n);
    if (wire === 0) {
      const parsed = readVarint(input, offset);
      output.push({ number, wire, value: parsed.value });
      offset = parsed.offset;
      continue;
    }
    if (wire !== 2) throw new Error(`Unsupported wire type ${wire}`);
    const parsedLength = readVarint(input, offset);
    offset = parsedLength.offset;
    const end = offset + Number(parsedLength.value);
    if (end > input.byteLength) throw new Error("Truncated field");
    output.push({ number, wire, value: input.subarray(offset, end) });
    offset = end;
  }
  return output;
}

function byteField(items: readonly Field[], number: number, index = 0): Uint8Array {
  const field = items.filter((item) => item.number === number && item.wire === 2)[index];
  if (!field || typeof field.value === "bigint") throw new Error(`Missing field ${number}`);
  return field.value;
}

function byteFields(items: readonly Field[], number: number): Uint8Array[] {
  return items
    .filter((item) => item.number === number && item.wire === 2)
    .map((field) => {
      if (typeof field.value === "bigint") throw new Error(`Invalid field ${number}`);
      return field.value;
    });
}

function numberField(items: readonly Field[], number: number): number {
  const field = items.find((item) => item.number === number && item.wire === 0);
  if (!field || typeof field.value !== "bigint") throw new Error(`Missing field ${number}`);
  return Number(field.value);
}

function rootFields(request: CursorTransportRequest): Field[] {
  const envelope = fields(request.body.subarray(5));
  return fields(byteField(envelope, 1));
}

function rootText(root: readonly Field[], number: number): string {
  return decoder.decode(byteField(root, number));
}

function pngDataUrl(width: number, height: number): string {
  const bytes = makeRedBluePng(width, height);
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

function jpegDataUrl(width: number, height: number): string {
  const bytes = new Uint8Array(38);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  new DataView(bytes.buffer).setUint16(7, height, false);
  new DataView(bytes.buffer).setUint16(9, width, false);
  bytes.set([0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00], 11);
  bytes.set([
    0xff, 0xda, 0x00, 0x0c, 0x03,
    0x01, 0x00, 0x02, 0x11, 0x03, 0x11,
    0x00, 0x3f, 0x00,
  ], 21);
  bytes[35] = 0;
  bytes.set([0xff, 0xd9], 36);
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
}

function gifDataUrl(width: number, height: number): string {
  const bytes = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return `data:image/gif;base64,${Buffer.from(bytes).toString("base64")}`;
}

function webpDataUrl(width: number, height: number): string {
  const bytes = new Uint8Array(30);
  const view = new DataView(bytes.buffer);
  bytes.set(Buffer.from("RIFF", "ascii"), 0);
  view.setUint32(4, 22, true);
  bytes.set(Buffer.from("WEBPVP8 ", "ascii"), 8);
  view.setUint32(16, 10, true);
  bytes.set([0, 0, 0, 0x9d, 0x01, 0x2a], 20);
  view.setUint16(26, width, true);
  view.setUint16(28, height, true);
  return `data:image/webp;base64,${Buffer.from(bytes).toString("base64")}`;
}

function emptyGifDataUrl(): string {
  const bytes = Buffer.from(gifDataUrl(2, 2).split(",")[1] ?? "", "base64");
  const imageOffset = bytes.indexOf(0x2c);
  if (imageOffset < 0) throw new Error("GIF fixture is missing an image descriptor");
  const empty = Buffer.concat([bytes.subarray(0, imageOffset + 11), Buffer.from([0, 0x3b])]);
  return `data:image/gif;base64,${empty.toString("base64")}`;
}

function emptyJpegDataUrl(): string {
  const bytes = Buffer.from(jpegDataUrl(2, 2).split(",")[1] ?? "", "base64");
  const empty = Buffer.concat([bytes.subarray(0, 35), bytes.subarray(36)]);
  return `data:image/jpeg;base64,${empty.toString("base64")}`;
}

function emptyAnimatedWebpDataUrl(): string {
  const bytes = new Uint8Array(58);
  const view = new DataView(bytes.buffer);
  bytes.set(Buffer.from("RIFF", "ascii"), 0);
  view.setUint32(4, 50, true);
  bytes.set(Buffer.from("WEBPVP8X", "ascii"), 8);
  view.setUint32(16, 10, true);
  bytes[20] = 2;
  bytes.set(Buffer.from("ANMF", "ascii"), 30);
  view.setUint32(34, 20, true);
  return `data:image/webp;base64,${Buffer.from(bytes).toString("base64")}`;
}

interface SseRecord {
  done: boolean;
  value?: Record<string, unknown>;
}

async function sse(response: Response): Promise<SseRecord[]> {
  const text = await response.text();
  return text.split("\n\n").filter(Boolean).map((block) => {
    if (!block.startsWith("data: ")) throw new Error("Invalid SSE block");
    const data = block.slice(6);
    if (data === "[DONE]") return { done: true };
    const value: unknown = JSON.parse(data);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Invalid SSE value");
    }
    return { done: false, value: value as Record<string, unknown> };
  });
}

function choices(record: SseRecord): readonly Record<string, unknown>[] {
  const value = record.value?.choices;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> =>
    typeof item === "object" && item !== null && !Array.isArray(item));
}

function usage(value: Record<string, unknown>): Record<string, number> {
  const raw = value.usage;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Missing usage");
  const output: Record<string, number> = {};
  for (const [key, item] of Object.entries(raw)) {
    if (typeof item === "number") output[key] = item;
  }
  return output;
}

describe("createCursorFetch", () => {
  test("merges Request and init headers, strips caller auth, and selects the exact variant public id", async () => {
    const transport = new FakeTransport(() => transportResponse([frame(responseText("ok"))]));
    const cursorFetch = makeFetch(transport);
    const selection = encodeCursorModelRequest({
      modelId: model.id,
      variant: "high",
    });
    const original = new Request("https://cursor.invalid/v1/chat/completions", requestInit(body(), {
      headers: {
        authorization: "Bearer must-not-forward",
        "content-type": "application/json",
        "x-opencode-cursor-selection": selection,
      },
    }));
    const initHeaders = { "x-caller-header": "preserved-only-locally" };

    const response = await cursorFetch(original, { headers: initHeaders });

    expect(response.status).toBe(200);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.accessToken).toBe(TOKEN);
    expect(transport.requests[0]?.path).toBe(UNIFIED_CHAT_PATH);
    const modelFields = fields(byteField(rootFields(transport.requests[0]!), 5));
    expect(decoder.decode(byteField(modelFields, 1))).toBe(highSelection.publicId);
    expect(numberField(modelFields, 8)).toBe(0);
    expect(original.headers.get("authorization")).toBe("Bearer must-not-forward");
    expect(original.headers.get("x-opencode-cursor-selection")).toBe(selection);
    expect(initHeaders).toEqual({ "x-caller-header": "preserved-only-locally" });
  });

  test("routes an explicit 1m model with the required wire flag", async () => {
    const transport = new FakeTransport(() => transportResponse([frame(responseText("ok"))]));
    const maxSelection: CursorModelSelection = {
      publicId: "gpt-5.4-medium",
      modelId: "gpt-5.4",
      displayName: "GPT-5.4 1M Medium",
      parameters: [
        { id: "context", value: "1m" },
        { id: "reasoning", value: "medium" },
      ],
      maxMode: true,
    };
    const maxModel: CursorModel = {
      id: "gpt-5.4-1m",
      name: "GPT-5.4 1M",
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      defaultSelection: maxSelection,
      variants: { medium: maxSelection },
    };

    const response = await makeFetch(transport, [maxModel])(
      "https://cursor.invalid/v1/chat/completions",
      requestInit(body({ model: maxModel.id })),
    );

    expect(response.status).toBe(200);
    expect(transport.requests).toHaveLength(1);
    const modelFields = fields(byteField(rootFields(transport.requests[0]!), 5));
    expect(decoder.decode(byteField(modelFields, 1))).toBe(maxSelection.publicId);
    expect(numberField(modelFields, 8)).toBe(1);
  });

  test("rejects a 1m route without an exact 1m selection parameter", async () => {
    const transport = new FakeTransport(() => transportResponse([frame(responseText("unused"))]));
    const maxSelection: CursorModelSelection = {
      publicId: "gpt-spoofed-medium",
      modelId: "gpt-spoofed",
      displayName: "GPT Spoofed",
      parameters: [{ id: "reasoning", value: "medium" }],
      maxMode: true,
    };
    const maxModel: CursorModel = {
      id: "gpt-spoofed-1m",
      name: "GPT Spoofed 1M",
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      defaultSelection: maxSelection,
      variants: {},
    };

    const response = await makeFetch(transport, [maxModel])(
      "https://cursor.invalid/v1/chat/completions",
      requestInit(body({ model: maxModel.id })),
    );

    expect(response.status).toBe(400);
    expect(transport.requests).toHaveLength(0);
  });

  test("streams text, reasoning, assistant role, finish, and DONE without default usage", async () => {
    const transport = new FakeTransport(() => transportResponse([
      frame(responseText("Hello ")).subarray(0, 3),
      frame(responseText("Hello ")).subarray(3),
      frame(responseReasoning("carefully")),
      frame(responseText("world")),
    ]));
    const response = await makeFetch(transport)(
      "https://cursor.invalid/chat/completions",
      requestInit(body({ stream: true })),
    );
    const records = await sse(response);

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(records.at(-1)).toEqual({ done: true });
    const deltas = records.flatMap(choices).map((choice) => choice.delta);
    expect(deltas[0]).toEqual({ role: "assistant", content: "Hello " });
    expect(deltas).toContainEqual({ reasoning_content: "carefully" });
    expect(deltas).toContainEqual({ content: "world" });
    expect(records.flatMap(choices).at(-1)?.finish_reason).toBe("stop");
    expect(records.some((record) => record.value?.usage !== undefined)).toBe(false);
  });

  test("returns non-streaming text, reasoning, and deterministic estimated usage", async () => {
    const transport = new FakeTransport(() => transportResponse([
      frame(concat(responseReasoning("analysis"), responseText("answer"))),
    ]));
    const response = await makeFetch(transport)(
      "https://cursor.invalid/v1/chat/completions",
      requestInit(body()),
    );
    const value = await json(response);
    const firstChoice = Array.isArray(value.choices) ? value.choices[0] : undefined;

    expect(firstChoice).toEqual({
      index: 0,
      message: { role: "assistant", content: "answer", reasoning_content: "analysis" },
      finish_reason: "stop",
    });
    expect(usage(value)).toEqual({
      prompt_tokens: expect.any(Number),
      completion_tokens: expect.any(Number),
      total_tokens: expect.any(Number),
    });
    expect(transport.requests[0]?.path).toBe(UNIFIED_CHAT_PATH);
  });

  test("encodes system/developer, PNG data, normal history, complex tools, and out-of-order parallel results", async () => {
    const transport = new FakeTransport(() => transportResponse([frame(responseText("continued"))]));
    const cursorFetch = makeFetch(transport);
    const messages = [
      { role: "system", content: "System A" },
      { role: "developer", content: "Developer B" },
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect" },
          { type: "image_url", image_url: { url: pngDataUrl(256, 128), detail: "high" } },
          { type: "text", text: "carefully" },
        ],
      },
      { role: "assistant", content: "Initial answer" },
      { role: "user", content: "Use both tools" },
      {
        role: "assistant",
        content: "I will inspect",
        tool_calls: [
          { id: "call-read", type: "function", function: { name: "read_file", arguments: "{\"path\":\"fixture.txt\"}" } },
          { id: "call-search", type: "function", function: { name: "search", arguments: "{\"query\":\"needle\",\"limit\":2}" } },
        ],
      },
      { role: "tool", tool_call_id: "call-search", content: "second result" },
      { role: "tool", tool_call_id: "call-read", content: "first result" },
    ];
    const tools = [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "search",
          description: "Search text",
          parameters: {
            type: "object",
            properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1 } },
            required: ["query"],
          },
        },
      },
    ];

    expect((await cursorFetch("https://cursor.invalid/v1/chat/completions", requestInit(body({ messages, tools })))).status)
      .toBe(200);
    const root = rootFields(transport.requests[0]!);
    const system = fields(byteField(root, 3));
    expect(decoder.decode(byteField(system, 1))).toBe("System A\nDeveloper B");
    const encodedMessages = byteFields(root, 1).map(fields);
    expect(encodedMessages).toHaveLength(5);
    expect(rootText(encodedMessages[0]!, 1)).toBe("Inspect\ncarefully");
    const image = fields(byteField(encodedMessages[0]!, 10));
    const dimensions = fields(byteField(image, 2));
    expect([numberField(dimensions, 1), numberField(dimensions, 2)]).toEqual([256, 128]);
    expect(rootText(encodedMessages[1]!, 1)).toBe("Initial answer");
    expect(rootText(encodedMessages[2]!, 1)).toBe("Use both tools");
    expect(rootText(encodedMessages[3]!, 1)).toBe("I will inspect");
    expect(numberField(encodedMessages[3]!, 2)).toBe(2);
    const results = byteFields(encodedMessages[3]!, 18).map(fields);
    expect(results.map((result) => rootText(result, 1))).toEqual(["call-read", "call-search"]);
    expect(results.map((result) => rootText(result, 7))).toEqual(["first result", "second result"]);
    expect(rootText(encodedMessages[4]!, 1)).toBe(
      "Continue from the tool result and follow the original request.",
    );
    expect(numberField(encodedMessages[4]!, 2)).toBe(1);
    const descriptors = byteFields(root, 34).map(fields);
    expect(descriptors.map((item) => rootText(item, 1))).toEqual(["opencode-read_file", "opencode-search"]);
    expect(JSON.parse(rootText(descriptors[0]!, 3))).toEqual(tools[0]?.function.parameters);
  });

  test("accepts bounded JPEG, GIF, and WebP image data with parsed dimensions", async () => {
    const transport = new FakeTransport(() => transportResponse([frame(responseText("ok"))]));
    const cursorFetch = makeFetch(transport);
    for (const url of [jpegDataUrl(320, 180), gifDataUrl(640, 360), webpDataUrl(800, 450)]) {
      const response = await cursorFetch(
        "https://cursor.invalid/v1/chat/completions",
        requestInit(body({
          messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }],
        })),
      );
      expect(response.status).toBe(200);
    }
    const dimensions = transport.requests.map((request) => {
      const message = fields(byteField(rootFields(request), 1));
      const image = fields(byteField(message, 10));
      const size = fields(byteField(image, 2));
      return [numberField(size, 1), numberField(size, 2)];
    });
    expect(dimensions).toEqual([[320, 180], [640, 360], [800, 450]]);
  });

  test("emits stable parallel tool calls once despite duplicate final snapshots", async () => {
    const first = responseCall({
      id: "call-2", name: "search", arguments: { query: "two" }, index: 1, isLast: true,
    });
    const duplicate = responseCall({
      id: "call-2", name: "search", arguments: { query: "two" }, index: 1, isLast: true,
    });
    const second = responseCall({
      id: "call-1", name: "read_file", arguments: { path: "one" }, index: 0,
    });
    const transport = new FakeTransport(() => transportResponse([frame(first), frame(duplicate), frame(second)]));
    const response = await makeFetch(transport)(
      "https://cursor.invalid/v1/chat/completions",
      requestInit(body({
        stream: true,
        tools: [
          { type: "function", function: { name: "read_file", parameters: {} } },
          { type: "function", function: { name: "search", parameters: {} } },
        ],
      })),
    );
    const records = await sse(response);
    const toolDeltas = records.flatMap(choices).flatMap((choice) => {
      const delta = choice.delta;
      if (!isRecord(delta)) return [];
      return Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    });

    expect(toolDeltas).toEqual([
      {
        index: 0,
        id: wrappedToolCallId({ id: "call-1" }),
        type: "function",
        function: { name: "read_file", arguments: "{\"path\":\"one\"}" },
      },
      {
        index: 1,
        id: wrappedToolCallId({ id: "call-2" }),
        type: "function",
        function: { name: "search", arguments: "{\"query\":\"two\"}" },
      },
    ]);
    expect(records.flatMap(choices).at(-1)?.finish_reason).toBe("tool_calls");
    expect(records.at(-1)).toEqual({ done: true });
  });

  test("returns non-streaming tool calls without duplication", async () => {
    const call = responseCall({ id: "call-1", name: "search", arguments: { query: "fixture" }, index: 0, isLast: true });
    const transport = new FakeTransport(() => transportResponse([
      frame(concat(responseReasoning("need data"), responseText("Checking"), call)),
      frame(call),
    ]));
    const response = await makeFetch(transport)(
      "https://cursor.invalid/v1/chat/completions",
      requestInit(body({
        tools: [{ type: "function", function: { name: "search", parameters: {} } }],
      })),
    );
    const value = await json(response);
    const firstChoice = Array.isArray(value.choices) ? value.choices[0] : undefined;

    expect(firstChoice).toEqual({
      index: 0,
      message: {
        role: "assistant",
        content: "Checking",
        reasoning_content: "need data",
        tool_calls: [{
          id: wrappedToolCallId({ id: "call-1" }),
          type: "function",
          function: { name: "search", arguments: "{\"query\":\"fixture\"}" },
        }],
      },
      finish_reason: "tool_calls",
    });
  });

  test("round-trips Cursor model-call metadata through the OpenAI tool id", async () => {
    const transport = new FakeTransport((_request, index) => transportResponse([
      index === 0
        ? frame(responseCall({
            id: "cursor-call-1",
            modelCallId: "cursor-model-call-1",
            name: "search",
            arguments: { query: "fixture" },
            index: 0,
            isLast: true,
          }))
        : frame(responseText("continued")),
    ]));
    const cursorFetch = makeFetch(transport);
    const tools = [{ type: "function", function: { name: "search", parameters: {} } }];
    const first = await cursorFetch(
      "https://cursor.invalid/v1/chat/completions",
      requestInit(body({ tools })),
    );
    const firstJson = await json(first);
    const firstChoice = Array.isArray(firstJson.choices) ? asRecordForTest(firstJson.choices[0]) : {};
    const message = asRecordForTest(firstChoice.message);
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const openAiCall = asRecordForTest(calls[0]);
    const externalId = String(openAiCall.id);
    expect(externalId.startsWith("oc_cursor_tool_call_v2_")).toBe(true);

    const second = await cursorFetch(
      "https://cursor.invalid/v1/chat/completions",
      requestInit(body({
        messages: [
          { role: "user", content: "Search" },
          { role: "assistant", content: null, tool_calls: [openAiCall] },
          { role: "tool", tool_call_id: externalId, content: "result" },
        ],
        tools,
      })),
    );
    expect(second.status).toBe(200);
    const replayMessage = byteFields(rootFields(transport.requests[1]!), 1).map(fields)[1];
    const replay = fields(byteField(replayMessage!, 18));
    expect(rootText(replay, 1)).toBe("cursor-call-1");
    expect(rootText(replay, 12)).toBe("cursor-model-call-1");
  });

  test("round-trips non-default tool routing without model-call metadata", async () => {
    const transport = new FakeTransport((_request, index) => transportResponse([
      index === 0
        ? frame(responseCall({
            id: "cursor-call-1",
            name: "bash",
            serverName: "bash",
            wireName: "call_mcp_tool",
            arguments: { command: "pwd" },
            index: 0,
            isLast: true,
          }))
        : frame(responseText("continued")),
    ]));
    const cursorFetch = makeFetch(transport);
    const tools = [{ type: "function", function: { name: "bash", parameters: {} } }];
    const first = await cursorFetch(
      "https://cursor.invalid/v1/chat/completions",
      requestInit(body({ tools })),
    );
    const firstJson = await json(first);
    const firstChoice = Array.isArray(firstJson.choices) ? asRecordForTest(firstJson.choices[0]) : {};
    const message = asRecordForTest(firstChoice.message);
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const openAiCall = asRecordForTest(calls[0]);
    const externalId = String(openAiCall.id);
    expect(externalId.startsWith("oc_cursor_tool_call_v2_")).toBe(true);

    await cursorFetch(
      "https://cursor.invalid/v1/chat/completions",
      requestInit(body({
        messages: [
          { role: "user", content: "Run pwd" },
          { role: "assistant", content: null, tool_calls: [openAiCall] },
          { role: "tool", tool_call_id: externalId, content: "/fixture" },
        ],
        tools,
      })),
    );
    const replay = fields(byteField(byteFields(rootFields(transport.requests[1]!), 1).map(fields)[1]!, 18));
    expect(rootText(replay, 2)).toBe("call_mcp_tool");
    const clientResult = fields(byteField(replay, 8));
    const resultParams = fields(byteField(clientResult, 62));
    expect(rootText(resultParams, 1)).toBe("bash");
    const clientCall = fields(byteField(replay, 11));
    expect(rootText(clientCall, 9)).toBe("call_mcp_tool");
    const callParams = fields(byteField(clientCall, 62));
    expect(rootText(callParams, 1)).toBe("bash");
  });

  test("escapes upstream call ids that collide with the metadata prefix", async () => {
    const collidingId = `oc_cursor_model_call_v1_${Buffer.from(JSON.stringify({
      id: "injected-id",
      serverName: "unrelated",
    }), "utf8").toString("base64url")}`;
    const transport = new FakeTransport((_request, index) => transportResponse([
      index === 0
        ? frame(responseCall({
            id: collidingId,
            name: "search",
            arguments: { query: "fixture" },
            index: 0,
            isLast: true,
          }))
        : frame(responseText("continued")),
    ]));
    const cursorFetch = makeFetch(transport);
    const tools = [{ type: "function", function: { name: "search", parameters: {} } }];
    const first = await cursorFetch(
      "https://cursor.invalid/v1/chat/completions",
      requestInit(body({ tools })),
    );
    const firstJson = await json(first);
    const firstChoice = Array.isArray(firstJson.choices) ? asRecordForTest(firstJson.choices[0]) : {};
    const message = asRecordForTest(firstChoice.message);
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const openAiCall = asRecordForTest(calls[0]);
    expect(openAiCall.id).not.toBe(collidingId);

    await cursorFetch(
      "https://cursor.invalid/v1/chat/completions",
      requestInit(body({
        messages: [
          { role: "user", content: "Search" },
          { role: "assistant", content: null, tool_calls: [openAiCall] },
          { role: "tool", tool_call_id: openAiCall.id, content: "result" },
        ],
        tools,
      })),
    );
    const replay = fields(byteField(byteFields(rootFields(transport.requests[1]!), 1).map(fields)[1]!, 18));
    expect(rootText(replay, 1)).toBe(collidingId);
    const clientResult = fields(byteField(replay, 8));
    const resultParams = fields(byteField(clientResult, 62));
    expect(rootText(resultParams, 1)).toBe("opencode");
  });

  test("rejects unrelated server namespaces in replay metadata", async () => {
    const externalId = `oc_cursor_tool_call_v2_${Buffer.from(JSON.stringify({
      id: "call-1",
      serverName: "unrelated",
    }), "utf8").toString("base64url")}`;
    const transport = new FakeTransport(() => transportResponse([frame(responseText("unused"))]));
    const response = await makeFetch(transport)(
      "https://cursor.invalid/v1/chat/completions",
      requestInit(body({
        messages: [
          { role: "user", content: "Search" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: externalId,
              type: "function",
              function: { name: "search", arguments: "{}" },
            }],
          },
          { role: "tool", tool_call_id: externalId, content: "result" },
        ],
        tools: [{ type: "function", function: { name: "search", parameters: {} } }],
      })),
    );

    expect(response.status).toBe(400);
    expect(transport.requests).toHaveLength(0);
  });

  test("rejects an upstream call for a tool that was not offered", async () => {
    const call = responseCall({ id: "call-1", name: "unknown", arguments: {}, index: 0, isLast: true });
    const transport = new FakeTransport(() => transportResponse([frame(call)]));
    const response = await makeFetch(transport)(
      "https://cursor.invalid/v1/chat/completions",
      requestInit(body({
        tools: [{ type: "function", function: { name: "known", parameters: {} } }],
      })),
    );

    expect(response.status).toBe(502);
    expect(await json(response)).toMatchObject({ error: { code: "cursor_protocol_error" } });
  });

  test("supports none and rejects unproven required or named tool choice", async () => {
    const transport = new FakeTransport(() => transportResponse([frame(responseText("ok"))]));
    const cursorFetch = makeFetch(transport);
    const tools = [
      { type: "function", function: { name: "Exact_Name", parameters: {} } },
      { type: "function", function: { name: "other", parameters: {} } },
    ];

    const named = await cursorFetch("https://cursor.invalid/v1/chat/completions", requestInit(body({
      tools,
      tool_choice: { type: "function", function: { name: "Exact_Name" } },
    })));
    await cursorFetch("https://cursor.invalid/v1/chat/completions", requestInit(body({
      tools,
      tool_choice: "none",
    })));
    const required = await cursorFetch("https://cursor.invalid/v1/chat/completions", requestInit(body({
      tools,
      tool_choice: "required",
    })));

    const none = byteFields(rootFields(transport.requests[0]!), 34);
    expect(none).toEqual([]);
    expect(named.status).toBe(400);
    expect(required.status).toBe(400);
  });

  test("replays historical tool results even when that tool is no longer offered", async () => {
    const transport = new FakeTransport(() => transportResponse([frame(responseText("continued"))]));
    const response = await makeFetch(transport)(
      "https://cursor.invalid/v1/chat/completions",
      requestInit(body({
        messages: [
          { role: "user", content: "Use the old tool" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "old-call",
              type: "function",
              function: { name: "removed_tool", arguments: "{\"value\":1}" },
            }],
          },
          { role: "tool", tool_call_id: "old-call", content: "old result" },
        ],
        tools: [],
      })),
    );
    expect(response.status).toBe(200);
    const replay = byteFields(rootFields(transport.requests[0]!), 1).map(fields)[1];
    expect(rootText(fields(byteField(replay!, 18)), 2)).toBe("opencode-removed_tool");
  });

  test("does not expose a tool call when a later Connect trailer fails", async () => {
    const call = responseCall({
      id: "call-1",
      name: "search",
      arguments: { query: "fixture" },
      index: 0,
      isLast: true,
    });
    const transport = new FakeTransport(() => transportResponse([
      frame(call),
      trailerError("permission_denied", "private detail"),
    ]));
    const response = await makeFetch(transport)(
      "https://cursor.invalid/v1/chat/completions",
      requestInit(body({
        stream: true,
        tools: [{ type: "function", function: { name: "search", parameters: {} } }],
      })),
    );
    const records = await sse(response);
    const emittedCalls = records.flatMap(choices).flatMap((choice) => {
      const delta = choice.delta;
      return isRecord(delta) && Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    });
    expect(emittedCalls).toEqual([]);
    expect(records.some((record) => record.value?.error !== undefined)).toBe(true);
  });

  test("rejects malformed request shapes, roles, parts, tools, and tool choice with OpenAI 400 envelopes", async () => {
    const transport = new FakeTransport(() => transportResponse([frame(responseText("unused"))]));
    const cursorFetch = makeFetch(transport);
    const invalidCases: Array<{ value: Record<string, unknown>; init?: RequestInit }> = [
      { value: body(), init: { method: "GET" } },
      { value: body({ model: 7 }) },
      { value: body({ messages: "invalid" }) },
      { value: body({ stream: "true" }) },
      { value: body({ messages: [{ role: "system", content: [{ type: "text", text: "no" }] }] }) },
      { value: body({ messages: [{ role: "user", content: [{ type: "audio", data: "no" }] }] }) },
      { value: body({ messages: [{ role: "critic", content: "no" }] }) },
      { value: body({ tools: [{ type: "custom", function: { name: "bad", parameters: {} } }] }) },
      { value: body({ tools: [{ type: "function", function: { name: "same", parameters: {} } }, { type: "function", function: { name: "same", parameters: {} } }] }) },
      { value: body({ tools: [{ type: "function", function: { name: "known", parameters: {} } }], tool_choice: "sometimes" }) },
      { value: body({ tools: [], tool_choice: "required" }) },
      { value: body({ stream_options: { include_usage: "yes" } }) },
    ];

    for (const invalid of invalidCases) {
      const response = await cursorFetch(
        "https://cursor.invalid/v1/chat/completions",
        requestInit(invalid.value, invalid.init),
      );
      expect(response.status).toBe(400);
      expect(await json(response)).toMatchObject({ error: { type: "invalid_request_error" } });
    }
    const malformed = await cursorFetch("https://cursor.invalid/v1/chat/completions", {
      method: "POST",
      body: "{",
    });
    const wrongPath = await cursorFetch("https://cursor.invalid/v1/responses", requestInit(body()));
    expect(malformed.status).toBe(400);
    expect(wrongPath.status).toBe(400);
    expect(transport.requests).toHaveLength(0);
  });

  test("rejects invalid tool-call and result correlation", async () => {
    const transport = new FakeTransport(() => transportResponse([frame(responseText("unused"))]));
    const cursorFetch = makeFetch(transport);
    const tool = { type: "function", function: { name: "known", parameters: {} } };
    const call = (id: string, name = "known", argumentsValue = "{}") => ({
      id, type: "function", function: { name, arguments: argumentsValue },
    });
    const invalidMessages: unknown[][] = [
      [{ role: "assistant", content: null, tool_calls: [call("same"), call("same")] }, { role: "tool", tool_call_id: "same", content: "one" }],
      [{ role: "assistant", content: null, tool_calls: [call("call", "known", "[]")] }, { role: "tool", tool_call_id: "call", content: "one" }],
      [{ role: "assistant", content: null, tool_calls: [call("one"), call("two")] }, { role: "tool", tool_call_id: "one", content: "one" }],
      [{ role: "assistant", content: null, tool_calls: [call("one")] }, { role: "tool", tool_call_id: "one", content: "one" }, { role: "tool", tool_call_id: "one", content: "duplicate" }],
      [{ role: "assistant", content: null, tool_calls: [call("one")] }, { role: "tool", tool_call_id: "unknown", content: "one" }],
      [{ role: "tool", tool_call_id: "orphan", content: "one" }],
    ];

    for (const messages of invalidMessages) {
      const response = await cursorFetch("https://cursor.invalid/v1/chat/completions", requestInit(body({
        messages,
        tools: [tool],
      })));
      expect(response.status).toBe(400);
    }
    expect(transport.requests).toHaveLength(0);
  });

  test("rejects oversized historical tool arguments before parsing them", async () => {
    const transport = new FakeTransport(() => transportResponse([frame(responseText("unused"))]));
    const cursorFetch = makeFetch(transport);
    const oversizedArguments = `{"value":"${"x".repeat(UNIFIED_CHAT_LIMITS.maxToolArgumentsBytes)}`;
    const response = await cursorFetch("https://cursor.invalid/v1/chat/completions", requestInit(body({
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: { name: "known", arguments: oversizedArguments },
          }],
        },
        { role: "tool", tool_call_id: "call-1", content: "result" },
      ],
      tools: [{ type: "function", function: { name: "known", parameters: {} } }],
    })));

    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ error: { message: "Tool arguments exceed limit" } });
    expect(transport.requests).toHaveLength(0);
  });

  test("rejects remote, unsupported, noncanonical, malformed, and truncated images", async () => {
    const transport = new FakeTransport(() => transportResponse([frame(responseText("unused"))]));
    const cursorFetch = makeFetch(transport);
    const badSignature = `data:image/png;base64,${Buffer.from("not a png").toString("base64")}`;
    const badIhdr = Buffer.from(pngDataUrl(1, 1).split(",")[1]!, "base64");
    badIhdr[12] = 88;
    const zeroDimensions = pngDataUrl(0, 1);
    const truncate = (url: string): string => {
      const [prefix, encoded] = url.split(",", 2);
      const bytes = Buffer.from(encoded ?? "", "base64");
      return `${prefix},${bytes.subarray(0, Math.max(0, bytes.length - 2)).toString("base64")}`;
    };
    const urls = [
      "https://example.invalid/image.png",
      "data:image/jpeg;base64,AAAA",
      "data:image/png;base64,AA A=",
      "data:image/png;base64,AB==",
      "data:image/png;base64,!!!!",
      badSignature,
      `data:image/png;base64,${badIhdr.toString("base64")}`,
      zeroDimensions,
      truncate(pngDataUrl(2, 2)),
      truncate(jpegDataUrl(2, 2)),
      truncate(gifDataUrl(2, 2)),
      truncate(webpDataUrl(2, 2)),
      emptyJpegDataUrl(),
      emptyGifDataUrl(),
      emptyAnimatedWebpDataUrl(),
      "data:image/heic;base64,AAAA",
    ];

    for (const url of urls) {
      const response = await cursorFetch("https://cursor.invalid/v1/chat/completions", requestInit(body({
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }],
      })));
      expect(response.status).toBe(400);
    }
    expect(transport.requests).toHaveLength(0);
  });

  test("rejects malformed, mismatched, unqualified 1m, default, Composer, and unsupported-family selections", async () => {
    const transport = new FakeTransport(() => transportResponse([frame(responseText("unused"))]));
    const cursorFetch = makeFetch(transport);
    const headers = (selection: string) => ({ "x-opencode-cursor-selection": selection });
    const mismatch = encodeCursorModelRequest({
      modelId: "different-model",
      variant: "high",
    });
    const maxSelection = { ...highSelection, publicId: "claude-4-test-max", maxMode: true };
    const maxModel = { ...model, variants: { max: maxSelection } } satisfies CursorModel;
    const unsupported = (id: string): CursorModel => ({
      ...model,
      id,
      defaultSelection: { ...defaultSelection, publicId: id, modelId: id, displayName: id },
      variants: {},
    });

    const malformed = await cursorFetch("https://cursor.invalid/v1/chat/completions", requestInit(body(), { headers: headers("%%%") }));
    const noncanonical = await cursorFetch("https://cursor.invalid/v1/chat/completions", requestInit(body(), {
      headers: headers(`${encodeCursorModelRequest({ modelId: model.id })}==`),
    }));
    const mismatched = await cursorFetch("https://cursor.invalid/v1/chat/completions", requestInit(body(), { headers: headers(mismatch) }));
    const unknownVariant = await cursorFetch("https://cursor.invalid/v1/chat/completions", requestInit(body(), {
      headers: headers(encodeCursorModelRequest({ modelId: model.id, variant: "unknown" })),
    }));
    const unknownModel = await cursorFetch("https://cursor.invalid/v1/chat/completions", requestInit(body({ model: "unknown" })));
    const maxFetch = makeFetch(transport, [maxModel]);
    const max = await maxFetch("https://cursor.invalid/v1/chat/completions", requestInit(body(), {
      headers: headers(encodeCursorModelRequest({ modelId: maxModel.id, variant: "max" })),
    }));
    const statuses = [malformed, noncanonical, mismatched, unknownVariant, unknownModel, max];
    for (const id of ["default", "composer-2", "grok-test"]) {
      const fetchUnsupported = makeFetch(transport, [unsupported(id)]);
      statuses.push(await fetchUnsupported("https://cursor.invalid/v1/chat/completions", requestInit(body({ model: id }))));
    }

    expect(statuses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400, 400, 400, 400, 400]);
    expect(transport.requests).toHaveLength(0);
  });

  test("rejects AbortError and propagates the caller signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = new FakeTransport((request) => {
      expect(request.signal).toBe(controller.signal);
      throw new DOMException("aborted", "AbortError");
    });

    await expect(makeFetch(transport)(
      "https://cursor.invalid/v1/chat/completions",
      requestInit(body(), { signal: controller.signal }),
    )).rejects.toHaveProperty("name", "AbortError");
    expect(transport.requests).toHaveLength(1);
  });

  test("maps transport and HTTP failures to safe JSON errors without exposing payloads", async () => {
    const transportFailure = new FakeTransport(() => {
      throw new Error("private transport detail");
    });
    let cancelled = false;
    const httpFailure = new FakeTransport(() => transportResponse(
      [encoder.encode("private upstream payload")],
      401,
      () => { cancelled = true; },
    ));

    const transportResponseValue = await makeFetch(transportFailure)(
      "https://cursor.invalid/v1/chat/completions",
      requestInit(body()),
    );
    const httpResponseValue = await makeFetch(httpFailure)(
      "https://cursor.invalid/v1/chat/completions",
      requestInit(body()),
    );
    const transportText = await transportResponseValue.text();
    const httpText = await httpResponseValue.text();

    expect(transportResponseValue.status).toBe(502);
    expect(httpResponseValue.status).toBe(401);
    expect(cancelled).toBe(true);
    expect(transportText).not.toContain("private transport detail");
    expect(httpText).not.toContain("private upstream payload");
  });

  test("maps transport timeouts to 504 without exposing details", async () => {
    const timeout = new Error("private timeout detail");
    timeout.name = "TimeoutError";
    const transport = new FakeTransport(() => { throw timeout; });

    const response = await makeFetch(transport)(
      "https://cursor.invalid/v1/chat/completions",
      requestInit(body()),
    );
    const text = await response.text();

    expect(response.status).toBe(504);
    expect(text).toContain("cursor_timeout");
    expect(text).not.toContain("private timeout detail");
  });

  test("maps Connect failures to safe JSON and SSE errors", async () => {
    const message = "private upstream Connect detail";
    const nonStreamTransport = new FakeTransport(() => transportResponse([trailerError("unavailable", message)]));
    const streamTransport = new FakeTransport(() => transportResponse([trailerError("permission_denied", message)]));

    const nonStream = await makeFetch(nonStreamTransport)(
      "https://cursor.invalid/v1/chat/completions",
      requestInit(body()),
    );
    const stream = await makeFetch(streamTransport)(
      "https://cursor.invalid/v1/chat/completions",
      requestInit(body({ stream: true })),
    );
    const streamText = await stream.text();

    expect(nonStream.status).toBe(503);
    expect(await nonStream.text()).not.toContain(message);
    expect(stream.status).toBe(200);
    expect(streamText).toContain('"error"');
    expect(streamText).not.toContain(message);
    expect(streamText).toContain("data: [DONE]\n\n");
  });

  test("cancels the upstream reader when the output stream is cancelled", async () => {
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() { cancelled = true; },
    });
    const transport = new FakeTransport(() => ({
      status: 200,
      headers: new Headers(),
      trailers: Promise.resolve(new Headers()),
      body: upstream,
    }));
    const response = await makeFetch(transport)(
      "https://cursor.invalid/v1/chat/completions",
      requestInit(body({ stream: true })),
    );

    await response.body?.cancel("consumer stopped");
    expect(cancelled).toBe(true);
  });

  test("usage is monotonic over replay text, schemas, image dimensions, and output", async () => {
    const transport = new FakeTransport((_request, index) => transportResponse([
      frame(responseText(index === 0 ? "x" : "a much longer synthetic answer")),
    ]));
    const cursorFetch = makeFetch(transport);
    const shortResponse = await cursorFetch(
      "https://cursor.invalid/v1/chat/completions",
      requestInit(body({ messages: [{ role: "user", content: "x" }] })),
    );
    const longResponse = await cursorFetch(
      "https://cursor.invalid/v1/chat/completions",
      requestInit(body({
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "x".repeat(400) },
            { type: "image_url", image_url: { url: pngDataUrl(512, 256) } },
          ],
        }],
        tools: [{
          type: "function",
          function: {
            name: "complex",
            description: "A longer description",
            parameters: {
              type: "object",
              properties: { nested: { type: "array", items: { type: "string" } } },
            },
          },
        }],
      })),
    );
    const shortUsage = usage(await json(shortResponse));
    const longUsage = usage(await json(longResponse));

    expect(longUsage.prompt_tokens).toBeGreaterThan(shortUsage.prompt_tokens ?? 0);
    expect(longUsage.completion_tokens).toBeGreaterThan(shortUsage.completion_tokens ?? 0);
    expect(longUsage.total_tokens).toBe(
      (longUsage.prompt_tokens ?? 0) + (longUsage.completion_tokens ?? 0),
    );
  });

  test("emits stream usage only as a trailing empty-choices chunk when requested", async () => {
    const transport = new FakeTransport(() => transportResponse([frame(responseText("ok"))]));
    const response = await makeFetch(transport)(
      "https://cursor.invalid/v1/chat/completions",
      requestInit(body({ stream: true, stream_options: { include_usage: true } })),
    );
    const records = await sse(response);
    const usageRecords = records.filter((record) => record.value?.usage !== undefined);

    expect(usageRecords).toHaveLength(1);
    expect(usageRecords[0]?.value?.choices).toEqual([]);
    expect(usage(usageRecords[0]!.value!)).toMatchObject({
      prompt_tokens: expect.any(Number),
      completion_tokens: expect.any(Number),
      total_tokens: expect.any(Number),
    });
    expect(records.at(-1)).toEqual({ done: true });
  });

  test("keeps identical concurrent prompts independent", async () => {
    let tokenCalls = 0;
    const transport = new FakeTransport(async (_request, index) => {
      while (transport.requests.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
      return transportResponse([frame(responseText(`response-${index}`))]);
    });
    const cursorFetch = makeFetch(transport, [model], async () => {
      tokenCalls += 1;
      return TOKEN;
    });
    const init = () => requestInit(body({ messages: [{ role: "user", content: "identical" }] }));

    const [first, second] = await Promise.all([
      cursorFetch("https://cursor.invalid/v1/chat/completions", init()),
      cursorFetch("https://cursor.invalid/v1/chat/completions", init()),
    ]);
    const [firstJson, secondJson] = await Promise.all([json(first), json(second)]);

    expect(transport.requests).toHaveLength(2);
    expect(tokenCalls).toBe(2);
    expect(transport.requests[0]?.body).not.toEqual(transport.requests[1]?.body);
    expect(JSON.stringify(firstJson)).toContain("response-0");
    expect(JSON.stringify(secondJson)).toContain("response-1");
  });
});
