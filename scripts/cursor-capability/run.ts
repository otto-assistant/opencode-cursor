import http2 from "node:http2";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import * as p from "../../src/proto/agent_pb.js";
import { buildRequest, decodeArgs, frame } from "./protocol.js";

export type ObservedCall = { id: string; name: string; args: ReturnType<typeof decodeArgs> };
export interface Observation {
  text: string;
  calls: ObservedCall[];
  execs: string[];
  blobReads: number;
  turnEnded: boolean;
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
  failure?: string;
}

export async function runProbe(input: Parameters<typeof buildRequest>[0] & {
  accessToken: string;
  url?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  execute?: (call: ObservedCall) => { text: string; isError?: boolean };
}): Promise<Observation> {
  const payload = buildRequest(input);
  const start = performance.now();
  const observation: Observation = { text: "", calls: [], execs: [], blobReads: 0,
    turnEnded: false, elapsedMs: 0, inputTokens: 0, outputTokens: 0 };
  const timeoutMs = input.timeoutMs ?? 180_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid probe timeout");
  if (input.signal?.aborted) return { ...observation, failure: "aborted" };
  const client = http2.connect(input.url ?? "https://api2.cursor.sh");
  return new Promise((resolve) => {
    let settled = false;
    let pending = Buffer.alloc(0);
    let receivedBytes = 0;
    let encoding: string | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const finish = (failure?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearInterval(heartbeat);
      input.signal?.removeEventListener("abort", abort);
      observation.failure = failure;
      observation.elapsedMs = Math.round(performance.now() - start);
      stream.close(http2.constants.NGHTTP2_CANCEL);
      client.destroy();
      resolve(observation);
    };
    const abort = () => finish("aborted");
    const deadline = setTimeout(() => finish("deadline"), timeoutMs);
    const requestHeaders: http2.OutgoingHttpHeaders = {
      ":method": "POST", ":path": "/agent.v1.AgentService/Run",
      "content-type": "application/connect+proto", "connect-protocol-version": "1", te: "trailers",
      authorization: `Bearer ${input.accessToken}`, "x-ghost-mode": "true",
      "x-cursor-client-version": "cli-2026.01.09-231024f", "x-cursor-client-type": "cli",
      "x-request-id": randomUUID(),
    };
    if (!input.tools.length) {
      requestHeaders["x-cursor-agent-allowed-tools"] = "";
    }
    const stream = client.request(requestHeaders);
    const send = (message: p.AgentClientMessage["message"]) => {
      if (!settled) stream.write(frame(toBinary(p.AgentClientMessageSchema, create(p.AgentClientMessageSchema, { message }))));
    };
    const onMessage = (message: p.AgentServerMessage) => {
      const item = message.message;
      if (item.case === "interactionUpdate") {
        const update = item.value.message;
        if (update.case === "textDelta") observation.text += update.value.text;
        if (update.case === "tokenDelta") observation.outputTokens += update.value.tokens;
        if (update.case === "turnEnded") { observation.turnEnded = true; finish(); }
      } else if (item.case === "conversationCheckpointUpdate") {
        observation.inputTokens = Math.max(observation.inputTokens, item.value.tokenDetails?.usedTokens ?? 0);
      } else if (item.case === "kvServerMessage") {
        const kv = item.value;
        const action = kv.message;
        let result: p.KvClientMessage["message"];
        if (action.case === "getBlobArgs") {
          observation.blobReads++;
          const data = payload.blobs.get(Buffer.from(action.value.blobId).toString("hex"));
          if (!data) { finish("missing-blob"); return; }
          result = { case: "getBlobResult", value: create(p.GetBlobResultSchema, { blobData: data }) };
        } else if (action.case === "setBlobArgs") {
          payload.blobs.set(Buffer.from(action.value.blobId).toString("hex"), action.value.blobData);
          result = { case: "setBlobResult", value: create(p.SetBlobResultSchema) };
        } else { finish("unknown-kv"); return; }
        send({ case: "kvClientMessage", value: create(p.KvClientMessageSchema, { id: kv.id, message: result }) });
      } else if (item.case === "execServerMessage") {
        const exec = item.value;
        const action = exec.message;
        observation.execs.push(action.case ?? "unknown");
        let result: p.ExecClientMessage["message"];
        if (action.case === "requestContextArgs") {
          result = { case: "requestContextResult", value: create(p.RequestContextResultSchema, {
            result: { case: "success", value: create(p.RequestContextSuccessSchema, { requestContext: payload.context }) },
          }) };
        } else if (action.case === "mcpArgs") {
          const name = action.value.toolName || action.value.name;
          if (!input.tools.some((tool) => tool.name === name) || !input.execute) { finish("unadvertised-tool"); return; }
          if (observation.calls.length >= 4) { finish("tool-budget"); return; }
          const call = { id: action.value.toolCallId, name, args: decodeArgs(action.value.args) };
          observation.calls.push(call);
          let output: { text: string; isError?: boolean };
          try { output = input.execute(call); }
          catch { finish("tool-verification"); return; }
          result = { case: "mcpResult", value: create(p.McpResultSchema, {
            result: { case: "success", value: create(p.McpSuccessSchema, {
              isError: output.isError ?? false,
              content: [create(p.McpToolResultContentItemSchema, {
                content: { case: "text", value: create(p.McpTextContentSchema, { text: output.text }) },
              })],
            }) },
          }) };
        } else { finish(`unexpected-exec:${action.case ?? "unknown"}`); return; }
        send({ case: "execClientMessage", value: create(p.ExecClientMessageSchema, { id: exec.id, execId: exec.execId, message: result }) });
      } else if (item.case === "interactionQuery") {
        finish("unexpected-query");
      } else if (item.case === undefined) {
        finish("unknown-server-message");
      }
    };
    stream.on("response", (headers) => {
      if (headers[":status"] !== 200) { finish(`http:${headers[":status"]}`); return; }
      encoding = String(headers["connect-content-encoding"] ?? "identity");
    });
    stream.on("trailers", (headers) => {
      if (headers["grpc-status"] && headers["grpc-status"] !== "0") finish(`grpc:${headers["grpc-status"]}`);
    });
    stream.on("data", (chunk: Buffer) => {
      if (settled) return;
      receivedBytes += chunk.length;
      if (receivedBytes > 8 * 1024 * 1024) { finish("response-budget"); return; }
      pending = Buffer.concat([pending, chunk]);
      try {
        while (!settled && pending.length >= 5) {
          const flags = pending[0]!;
          const length = pending.readUInt32BE(1);
          if (length > 8 * 1024 * 1024) { finish("frame-budget"); return; }
          if (pending.length < 5 + length) break;
          let bytes: Uint8Array = pending.subarray(5, 5 + length);
          pending = pending.subarray(5 + length);
          if (flags & 1) {
            if (encoding !== "gzip") { finish("unsupported-compression"); return; }
            bytes = gunzipSync(bytes, { maxOutputLength: 8 * 1024 * 1024 });
          }
          if (flags & 2) {
            const end: unknown = JSON.parse(Buffer.from(bytes).toString());
            const code = end && typeof end === "object" && "error" in end
              && end.error && typeof end.error === "object" && "code" in end.error ? String(end.error.code) : undefined;
            finish(code && /^[a-z_]+$/.test(code) ? `connect:${code}` : "missing-turn-ended");
          } else onMessage(fromBinary(p.AgentServerMessageSchema, bytes));
        }
      } catch { finish("invalid-frame-or-tool-input"); }
    });
    stream.on("end", () => finish("missing-turn-ended"));
    stream.on("close", () => finish("stream-closed"));
    stream.on("error", () => finish("stream-error"));
    client.on("error", () => finish("connection-error"));
    input.signal?.addEventListener("abort", abort, { once: true });
    heartbeat = setInterval(() => send({ case: "clientHeartbeat", value: create(p.ClientHeartbeatSchema) }), 5_000);
    stream.write(frame(payload.bytes));
  });
}
