// One Run per process. IPC: [type:u8][length:u32be][payload]. No shared stream
// globals, pooled leases, credential arguments, or conversation persistence.
import http2 from "node:http2";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

const LIMIT = 8 * 1024 * 1024;
let client;
let stream;
let ended = false;
let finished = false;
let encoding = "identity";
let network = Buffer.alloc(0);
let ipc = Buffer.alloc(0);

function packet(type, data = Buffer.alloc(0)) {
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, data]);
}
function emit(type, data) {
  if (process.stdout.writableLength > LIMIT * 2)
    return fail("ipc-output-capacity");
  if (!process.stdout.write(packet(type, data))) stream?.pause();
}
function finish(error) {
  if (finished) return;
  finished = true;
  process.stdin.pause();
  client?.destroy();
  emit(error ? 2 : 1, error ? Buffer.from(error) : undefined);
  process.stdout.end(() => process.exit(error ? 1 : 0));
}
function fail(code) {
  finish(code);
}
process.stdout.on("drain", () => stream?.resume());
process.stdout.on("error", () => process.exit(1));

function open(config) {
  if (
    client ||
    typeof config.accessToken !== "string" ||
    typeof config.url !== "string" ||
    typeof config.tools !== "boolean"
  ) {
    throw new Error("invalid-open");
  }
  const endpoint = new URL(config.url);
  if (
    endpoint.protocol !== "https:" &&
    !(
      endpoint.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
    )
  ) {
    throw new Error("invalid-endpoint");
  }
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/"
  )
    throw new Error("invalid-endpoint");
  client = http2.connect(endpoint.origin);
  client.on("error", () => fail("connection-error"));
  const requestHeaders = {
    ":method": "POST",
    ":path": "/agent.v1.AgentService/Run",
    "content-type": "application/connect+proto",
    "connect-protocol-version": "1",
    te: "trailers",
    authorization: `Bearer ${config.accessToken}`,
    "x-ghost-mode": "true",
    "x-cursor-client-version": "cli-2026.01.09-231024f",
    "x-cursor-client-type": "cli",
    "x-request-id": randomUUID(),
  };
  // Cursor's MCP tool family. Allowing only mcp_tool_call hides
  // get_mcp_tools_tool_call, which Cursor needs to start the Run.
  requestHeaders["x-cursor-agent-allowed-tools"] = config.tools
    ? "mcp_tool_call,get_mcp_tools_tool_call,list_mcp_resources_tool_call,read_mcp_resource_tool_call,mcp_auth_tool_call"
    : "";
  stream = client.request(requestHeaders);
  stream.on("drain", () => process.stdin.resume());
  stream.on("response", (headers) => {
    if (headers[":status"] !== 200)
      return fail(`http-${Number(headers[":status"]) || 0}`);
    if (
      !String(headers["content-type"]).startsWith("application/connect+proto")
    )
      return fail("invalid-content-type");
    encoding = String(headers["connect-content-encoding"] ?? "identity");
  });
  stream.on("trailers", (headers) => {
    if (headers["grpc-status"] && headers["grpc-status"] !== "0")
      fail("grpc-error");
  });
  stream.on("data", (data) => {
    if (finished) return;
    try {
      network = Buffer.concat([network, data]);
      while (network.length >= 5) {
        const flags = network[0];
        const size = network.readUInt32BE(1);
        if (flags > 3 || size > LIMIT || ended)
          throw new Error("invalid-frame");
        if (network.length < 5 + size) break;
        let bytes = network.subarray(5, 5 + size);
        network = network.subarray(5 + size);
        if (flags & 1) {
          if (encoding !== "gzip") throw new Error("unsupported-compression");
          bytes = gunzipSync(bytes, { maxOutputLength: LIMIT });
        }
        if (flags & 2) {
          const end = JSON.parse(bytes.toString());
          if (!end || typeof end !== "object" || Array.isArray(end))
            throw new Error("invalid-end-frame");
          if (end.error) {
            const code = String(end.error.code);
            const detail = end.error.message ? `: ${String(end.error.message)}` : "";
            return fail(
              (/^[a-z_]+$/.test(code) ? `connect-${code}` : "connect-error") + detail,
            );
          }
          ended = true;
        } else emit(0, bytes);
      }
    } catch {
      fail("invalid-connect-frame");
    }
  });
  stream.on("end", () =>
    finish(ended && network.length === 0 ? undefined : "premature-eof"),
  );
  stream.on("close", () => {
    if (!finished) fail("stream-closed");
  });
  stream.on("error", () => fail("stream-error"));
}

process.stdin.on("data", (data) => {
  if (finished) return;
  try {
    ipc = Buffer.concat([ipc, data]);
    while (ipc.length >= 5) {
      const type = ipc[0];
      const size = ipc.readUInt32BE(1);
      if (size > LIMIT) throw new Error("ipc-input-capacity");
      if (ipc.length < 5 + size) break;
      const bytes = ipc.subarray(5, 5 + size);
      ipc = ipc.subarray(5 + size);
      if (type === 0) open(JSON.parse(bytes.toString()));
      else if (type === 1 && stream && !stream.writableEnded) {
        if (stream.writableLength > LIMIT * 2)
          throw new Error("network-output-capacity");
        if (!stream.write(packet(0, bytes))) process.stdin.pause();
      } else throw new Error("invalid-ipc-command");
    }
  } catch {
    fail("invalid-ipc-command");
  }
});
process.stdin.on("end", () => {
  if (!finished && !stream?.writableEnded) fail("host-disconnected");
});
process.stdin.on("error", () => fail("host-disconnected"));
