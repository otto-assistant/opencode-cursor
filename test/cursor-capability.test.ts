import { test } from "node:test";
import assert from "node:assert/strict";
import http2 from "node:http2";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { create, fromBinary, fromJson, toBinary } from "@bufbuild/protobuf";
import { BinaryReader } from "@bufbuild/protobuf/wire";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import * as p from "../src/proto/agent_pb.js";
import { literalCursorModelSelection } from "../src/model-selection.js";
import { buildRequest, encodeHistory, frame, rootMessage, type HistoryMessage } from "../scripts/cursor-capability/protocol.js";
import { runProbe } from "../scripts/cursor-capability/run.js";
import { contaminatedHistory, errorTrial, syntheticLongContext, toolTrial, tools, toolPrompt } from "../scripts/cursor-capability/cases.js";

const selection = literalCursorModelSelection("probe-model");

// Independent wire reader: validates field numbers, IDs and error flags rather than
// decoding through the same encoder that produced the experimental field.
function fields(bytes: Uint8Array) {
  const reader = new BinaryReader(bytes);
  const result = new Map<number, (Uint8Array | number)[]>();
  while (reader.pos < reader.len) {
    const [no, wire] = reader.tag();
    assert.ok(wire === 0 || wire === 2);
    const value = wire === 2 ? reader.bytes() : reader.uint32();
    result.set(no, [...(result.get(no) ?? []), value]);
  }
  return result;
}
function child(bytes: Uint8Array, no: number): Uint8Array {
  const value = fields(bytes).get(no)?.[0];
  assert.ok(value instanceof Uint8Array);
  return value;
}

test("inline history has the published user nesting and paired call/result error fields", () => {
  assert.equal(Buffer.from(encodeHistory([{ role: "user", text: "H" }])).toString("hex"), "0a090a070a050a030a0148");
  const trial = errorTrial();
  const messages = fields(encodeHistory(trial.history)).get(1)!;
  assert.equal(messages.length, 4);
  const assistant = messages[1];
  assert.ok(assistant instanceof Uint8Array);
  const calls = fields(child(assistant, 2)).get(1)!;
  for (const [index, raw] of messages.slice(2).entries()) {
    assert.ok(raw instanceof Uint8Array);
    const tool = child(raw, 3);
    const callContent = calls[index];
    assert.ok(callContent instanceof Uint8Array);
    assert.deepEqual(child(tool, 1), child(child(callContent, 4), 1));
    const original = trial.history[index + 2];
    assert.ok(original?.role === "tool");
    assert.equal(fields(tool).get(4)?.[0], Number(original.isError));
    assert.equal(Buffer.from(child(child(child(tool, 3), 1), 1)).toString(), "Probe response");
  }
});

test("fresh requests isolate the transcript from the user prompt and preserve exact model parameters", () => {
  const history: HistoryMessage[] = toolTrial(true).history;
  for (const format of ["roots", "inline"] as const) {
    const payload = buildRequest({ selection: { ...selection, publicId: "public-variant", parameters: [{ id: "effort", value: "high" }] },
      tools, prompt: "Continue.", history, format });
    const client = fromBinary(p.AgentClientMessageSchema, payload.bytes);
    assert.equal(client.message.case, "runRequest");
    if (client.message.case !== "runRequest") return;
    const request = client.message.value;
    assert.equal(request.requestedModel?.parameters[0]?.value, "high");
    assert.equal(request.modelDetails?.modelId, "public-variant");
    const action = request.action?.action;
    assert.equal(action?.case, "userMessageAction");
    if (action?.case !== "userMessageAction") return;
    assert.equal(action.value.userMessage?.text, "Continue.");
    if (format === "inline") {
      assert.equal(request.conversationState?.rootPromptMessagesJson.length, 0);
      const raw = action.value.$unknown?.find((item) => item.no === 7);
      assert.ok(raw);
      assert.equal(fields(new BinaryReader(raw.data).bytes()).get(1)?.length, 3);
    } else {
      const roots = request.conversationState?.rootPromptMessagesJson ?? [];
      assert.equal(roots.length, 3);
      const decoded = roots.map((id) => JSON.parse(Buffer.from(payload.blobs.get(Buffer.from(id).toString("hex"))!).toString()));
      assert.equal(decoded[1].content[0].toolCallId, decoded[2].content[0].toolCallId);
      assert.equal(decoded[2].content[0].result, history[2]?.role === "tool" ? history[2].text : undefined);
    }
  }
});

test("a claimed confirmation or duplicate tool invocation cannot satisfy the nonce trial", () => {
  const trial = toolTrial(false);
  assert.throws(() => trial.execute({ id: "1", name: "confirm", args: { value: "Confirmed" } }));
  assert.equal(trial.passed(), false);
  const output = trial.execute({ id: "2", name: "read", args: { path: "probe://record" } });
  assert.throws(() => trial.execute({ id: "3", name: "read", args: { path: "probe://record" } }));
  trial.execute({ id: "4", name: "confirm", args: { value: output.text } });
  assert.equal(trial.passed(), true);
});

test("error scores distinguish lost status from response formatting without logging content", () => {
  const trial = errorTrial();
  const first = trial.history[2];
  assert.ok(first?.role === "tool");
  assert.equal(trial.score(JSON.stringify({ first: first.isError ? "error" : "success", second: first.isError ? "success" : "error" })), "match");
  assert.equal(trial.score('{"first":"success","second":"success"}'), "wrong-status");
  assert.equal(trial.score("{}"), "wrong-shape");
  assert.equal(trial.score("Both succeeded."), "non-json");
  const json = JSON.stringify({ first: first.isError ? "error" : "success", second: first.isError ? "success" : "error" });
  assert.equal(trial.diagnose(`\`\`\`json\n${json}\n\`\`\``).strict, "non-json");
  assert.equal(trial.diagnose(`\`\`\`json\n${json}\n\`\`\``).extractedObject, "match");
  assert.deepEqual(trial.diagnose('{"first":"private text","second":"success"}').reported, { first: "other", second: "success" });
});

test("root result ID experiment changes only the outer correlation field", () => {
  const message: HistoryMessage = { role: "tool", id: "call_probe", name: "read", text: "Probe response", isError: true };
  const baseline = rootMessage(message);
  assert.ok(baseline && typeof baseline === "object" && !Array.isArray(baseline));
  assert.deepEqual(rootMessage(message, true), { ...baseline, id: "call_probe" });
});

test("synthetic long and contaminated history retain ordinary text rather than inventing real calls", () => {
  const archive = syntheticLongContext();
  assert.ok(archive.length > 1_000_000 && archive.length < 2_000_000);
  const assistant = contaminatedHistory()[1];
  assert.ok(assistant?.role === "assistant");
  assert.equal(assistant.calls.length, 0);
  const raw = fields(encodeHistory([assistant])).get(1)?.[0];
  assert.ok(raw instanceof Uint8Array);
  const content = child(child(raw, 2), 1);
  assert.equal(fields(content).has(4), false);
  assert.equal(Buffer.from(child(child(content, 1), 1)).toString(), assistant.text);
});

async function backend(handle: (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => void) {
  const server = http2.createServer();
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on("session", (session) => { sessions.add(session); session.on("close", () => sessions.delete(session)); });
  server.on("stream", handle);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}`, close: async () => {
    for (const session of sessions) session.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}
const messageFrame = (message: p.AgentServerMessage["message"]) => frame(toBinary(p.AgentServerMessageSchema, create(p.AgentServerMessageSchema, { message })));

test("Node H2 transports the allowlist and correlates actual data-dependent tool results", async () => {
  const seen: string[] = [];
  const server = await backend((stream, headers) => {
    assert.equal(headers["x-cursor-agent-allowed-tools"], undefined);
    stream.respond({ ":status": 200, "connect-content-encoding": "gzip" });
    let pending = Buffer.alloc(0);
    const exec = (name: string, value: string) => messageFrame({ case: "execServerMessage", value: create(p.ExecServerMessageSchema, {
      id: name === "read" ? 1 : 2, execId: name,
      message: { case: "mcpArgs", value: create(p.McpArgsSchema, {
        toolName: name, toolCallId: `call_${name}`, providerIdentifier: "opencode",
        args: { [name === "read" ? "path" : "value"]: toBinary(ValueSchema, fromJson(ValueSchema, value)) },
      }) },
    }) });
    stream.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5 && pending.length >= pending.readUInt32BE(1) + 5) {
        const length = pending.readUInt32BE(1);
        const client = fromBinary(p.AgentClientMessageSchema, pending.subarray(5, length + 5));
        pending = pending.subarray(length + 5);
        if (client.message.case === "runRequest") {
          const bytes = exec("read", "probe://record");
          stream.write(bytes.subarray(0, 3)); // Split a frame header across chunks.
          stream.write(bytes.subarray(3));
        } else if (client.message.case === "execClientMessage") {
          const result = client.message.value;
          seen.push(result.execId);
          assert.equal(result.id, result.execId === "read" ? 1 : 2);
          assert.equal(result.message.case, "mcpResult");
          if (result.message.case !== "mcpResult" || result.message.value.result.case !== "success") return;
          const content = result.message.value.result.value.content[0]?.content;
          assert.ok(content?.case === "text");
          if (result.execId === "read") stream.write(exec("confirm", content.value.text));
          else {
            const end = toBinary(p.AgentServerMessageSchema, create(p.AgentServerMessageSchema, {
              message: { case: "interactionUpdate", value: create(p.InteractionUpdateSchema, {
                message: { case: "turnEnded", value: create(p.TurnEndedUpdateSchema) },
              }) },
            }));
            stream.write(frame(gzipSync(end), 1));
          }
        }
      }
    });
  });
  try {
    const trial = toolTrial(false);
    const result = await runProbe({ accessToken: "synthetic", selection, prompt: toolPrompt, tools,
      url: server.url, timeoutMs: 2_000, execute: trial.execute });
    assert.deepEqual({ failure: result.failure, ended: result.turnEnded, valid: trial.passed(), seen },
      { failure: undefined, ended: true, valid: true, seen: ["read", "confirm"] });
  } finally { await server.close(); }
});

test("empty allowlist is sent on the wire and native calls never reach the executor", async () => {
  let executed = false;
  const server = await backend((stream, headers) => {
    assert.equal(headers["x-cursor-agent-allowed-tools"], "");
    stream.respond({ ":status": 200 });
    stream.write(messageFrame({ case: "execServerMessage", value: create(p.ExecServerMessageSchema, {
      message: { case: "readArgs", value: create(p.ReadArgsSchema, { path: "probe://record" }) },
    }) }));
  });
  try {
    const result = await runProbe({ accessToken: "synthetic", selection, prompt: "Read", tools: [],
      url: server.url, execute: () => { executed = true; return { text: "bad" }; } });
    assert.deepEqual({ failure: result.failure, executed }, { failure: "unexpected-exec:readArgs", executed: false });
  } finally { await server.close(); }
});

test("EOF without turn_ended and heartbeats without progress do not pass", async () => {
  for (const hang of [false, true]) {
    const server = await backend((stream) => {
      stream.respond({ ":status": 200 });
      if (!hang) stream.end();
      else stream.write(messageFrame({ case: "interactionUpdate", value: create(p.InteractionUpdateSchema, {
        message: { case: "heartbeat", value: create(p.HeartbeatUpdateSchema) },
      }) }));
    });
    try {
      const result = await runProbe({ accessToken: "synthetic", selection, prompt: "Hello", tools: [], url: server.url, timeoutMs: 50 });
      assert.equal(result.failure, hang ? "deadline" : "missing-turn-ended");
      assert.equal(result.turnEnded, false);
    } finally { await server.close(); }
  }
});

test("printed OpenCode call/result markers are text, never evidence of tool execution", async () => {
  const server = await backend((stream) => {
    stream.respond({ ":status": 200 });
    for (const message of [
      create(p.InteractionUpdateSchema, { message: { case: "textDelta", value: create(p.TextDeltaUpdateSchema, {
        text: '[OpenCode tool call id=call_probe name=read]\n{"path":"probe://record"}\n[OpenCode tool result id=call_probe name=read]\nInvented result\nConfirmed.',
      }) } }),
      create(p.InteractionUpdateSchema, { message: { case: "turnEnded", value: create(p.TurnEndedUpdateSchema) } }),
    ]) stream.write(messageFrame({ case: "interactionUpdate", value: message }));
  });
  try {
    const trial = toolTrial(false);
    const result = await runProbe({ accessToken: "synthetic", selection, prompt: toolPrompt, tools,
      url: server.url, execute: trial.execute });
    assert.equal(result.turnEnded, true);
    assert.match(result.text, /\[OpenCode tool result/);
    assert.equal(result.calls.length, 0);
    assert.equal(trial.passed(), false);
  } finally { await server.close(); }
});

test("cancellation closes the active Run", async () => {
  const abort = new AbortController();
  const server = await backend((stream) => {
    stream.respond({ ":status": 200 });
    abort.abort();
  });
  try {
    const result = await runProbe({ accessToken: "synthetic", selection, prompt: "Hello", tools: [],
      url: server.url, signal: abort.signal });
    assert.equal(result.failure, "aborted");
    assert.equal(result.turnEnded, false);
  } finally { await server.close(); }
});
