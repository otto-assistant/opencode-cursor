import { createHash, randomUUID } from "node:crypto";
import { create, fromBinary, fromJson, toBinary, toJson, type JsonValue } from "@bufbuild/protobuf";
import { BinaryWriter } from "@bufbuild/protobuf/wire";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import * as p from "../../src/proto/agent_pb.js";
import type { CursorModelSelection } from "../../src/model-selection.js";

export type HistoryMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text?: string; calls: { id: string; name: string; args: Record<string, JsonValue> }[] }
  | { role: "tool"; id: string; name: string; text: string; isError: boolean };
export type HistoryFormat = "roots" | "inline";
export type ProbeTool = { name: string; description: string; parameter: string };

const field = (no: number, bytes: Uint8Array) => new BinaryWriter().uint32(no * 8 + 2).bytes(bytes).finish();
const string = (no: number, text: string) => new BinaryWriter().uint32(no * 8 + 2).string(text).finish();
const concat = (parts: readonly Uint8Array[]) => Buffer.concat(parts);
const textContent = (text: string) => field(1, string(1, text));

// Probe-only wire subset, checked against @cursor/sdk@1.0.31 descriptors.
// ConversationHistory.messages=1; message oneof user=1/assistant=2/tool=3.
// No change to the production generated descriptor is needed for this experiment.
export function encodeHistory(messages: readonly HistoryMessage[]): Uint8Array {
  return concat(messages.map((message) => {
    if (message.role === "user") return field(1, field(1, field(1, textContent(message.text))));
    if (message.role === "assistant") {
      return field(1, field(2, concat([
        ...(message.text ? [field(1, textContent(message.text))] : []),
        ...message.calls.map((call) => field(1, field(4, concat([
          string(1, call.id), string(2, call.name), string(3, JSON.stringify(call.args)),
        ])))),
      ])));
    }
    return field(1, field(3, concat([
      string(1, message.id), string(2, message.name), field(3, textContent(message.text)),
      new BinaryWriter().uint32(32).bool(message.isError).finish(),
    ])));
  }));
}

export function rootMessage(message: HistoryMessage, rootToolMessageId = false): JsonValue {
  if (message.role === "user") return { role: "user", content: [{ type: "text", text: message.text }] };
  if (message.role === "assistant") return {
    role: "assistant",
    content: [
      ...(message.text ? [{ type: "text", text: message.text }] : []),
      ...message.calls.map((call) => ({ type: "tool-call", toolCallId: call.id, toolName: call.name, args: call.args })),
    ],
  };
  return {
    role: "tool", ...(rootToolMessageId ? { id: message.id } : {}), content: [{ type: "tool-result", toolCallId: message.id,
      toolName: message.name, result: message.text, isError: message.isError }],
  };
}

export function buildRequest(input: {
  selection: CursorModelSelection;
  prompt: string;
  tools: readonly ProbeTool[];
  format?: HistoryFormat;
  history?: readonly HistoryMessage[];
  rootToolMessageId?: boolean;
}) {
  const blobs = new Map<string, Uint8Array>();
  const tools = input.tools.map((tool) => create(p.McpToolDefinitionSchema, {
    name: tool.name, toolName: tool.name, providerIdentifier: "opencode",
    description: tool.description,
    inputSchema: toBinary(ValueSchema, fromJson(ValueSchema, {
      type: "object", properties: { [tool.parameter]: { type: "string" } },
      required: [tool.parameter], additionalProperties: false,
    })),
  }));
  const context = create(p.RequestContextSchema, { tools });
  const userMessage = create(p.UserMessageSchema, { text: input.prompt, messageId: randomUUID(), mode: 1 });
  const userBytes = toBinary(p.UserMessageSchema, userMessage);
  blobs.set(Buffer.from(userBytes).toString("hex"), userBytes);
  const action = create(p.UserMessageActionSchema, { userMessage, requestContext: context });
  const roots: Uint8Array[] = [];
  if (input.format === "inline") {
    action.$unknown = [{ no: 7, wireType: 2, data: new BinaryWriter().bytes(encodeHistory(input.history ?? [])).finish() }];
  } else {
    for (const message of input.history ?? []) {
      const bytes = Buffer.from(JSON.stringify(rootMessage(message, input.rootToolMessageId)));
      const id = createHash("sha256").update(bytes).digest();
      roots.push(id);
      blobs.set(id.toString("hex"), bytes);
    }
  }
  const selection = input.selection;
  const request = create(p.AgentClientMessageSchema, { message: {
    case: "runRequest", value: create(p.AgentRunRequestSchema, {
      conversationId: randomUUID(),
      conversationState: create(p.ConversationStateStructureSchema, { rootPromptMessagesJson: roots }),
      action: create(p.ConversationActionSchema, { action: { case: "userMessageAction", value: action } }),
      modelDetails: create(p.ModelDetailsSchema, {
        modelId: selection.publicId, displayModelId: selection.publicId,
        displayName: selection.displayName, maxMode: selection.maxMode,
      }),
      requestedModel: create(p.RequestedModelSchema, {
        modelId: selection.modelId, maxMode: selection.maxMode,
        parameters: selection.parameters.map((item) => create(p.RequestedModel_ModelParameterbytesSchema, item)),
      }),
      mcpTools: create(p.McpToolsSchema, { mcpTools: tools }),
    }),
  } });
  return { bytes: toBinary(p.AgentClientMessageSchema, request), blobs, context };
}

export function decodeArgs(args: Record<string, Uint8Array>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, toJson(ValueSchema, fromBinary(ValueSchema, value))]));
}

export function frame(bytes: Uint8Array, flags = 0): Buffer {
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}
