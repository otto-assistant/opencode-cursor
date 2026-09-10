// One bounded unary Cursor RPC, isolated from the host's HTTP/2 implementation.
import http2 from "node:http2";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

const LIMIT = 8 * 1024 * 1024;
let input = Buffer.alloc(0);
let client;
let timer = setTimeout(() => fail(), 75_000);
let finished = false;
function fail() {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  client?.destroy();
  process.exitCode = 1;
  process.stdin.destroy();
}
process.stdin.on("error", fail);
process.stdout.on("error", fail);
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  if (input.length > LIMIT) fail();
});
process.stdin.on("end", () => {
  if (finished) return;
  try {
    const read = () => {
      if (input.length < 4) throw new Error("incomplete-input");
      const size = input.readUInt32BE(0);
      if (input.length < size + 4) throw new Error("incomplete-input");
      const frame = input.subarray(4, size + 4);
      input = input.subarray(size + 4);
      return frame;
    };
    const config = JSON.parse(read().toString());
    const body = read();
    if (read().length || input.length) throw new Error("unexpected-input");
    const url = new URL(config.url);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
        ))
    )
      throw new Error("invalid-endpoint");
    client = http2.connect(url.origin);
    client.on("error", fail);
    const stream = client.request({
      ":method": "POST",
      ":path": config.path,
      "content-type": config.contentType ?? "application/proto",
      ...(config.connectProtocolVersion === "1"
        ? { "connect-protocol-version": "1" }
        : {}),
      te: "trailers",
      authorization: `Bearer ${config.accessToken}`,
      "x-ghost-mode": "true",
      "x-cursor-client-version": "cli-2026.01.09-231024f",
      "x-cursor-client-type": "cli",
      "x-request-id": randomUUID(),
    });
    let response = Buffer.alloc(0);
    let encoding;
    let status;
    stream.on("error", fail);
    stream.on("response", (headers) => {
      status = headers[":status"];
      encoding = headers["content-encoding"];
      if (
        status !== 200 ||
        (headers["grpc-status"] && headers["grpc-status"] !== "0")
      )
        fail();
    });
    stream.on("trailers", (headers) => {
      if (headers["grpc-status"] && headers["grpc-status"] !== "0") fail();
    });
    stream.on("data", (chunk) => {
      response = Buffer.concat([response, chunk]);
      if (response.length > LIMIT) fail();
    });
    stream.on("end", () => {
      if (finished) return;
      try {
        if (status !== 200) throw new Error("missing-status");
        if (encoding === "gzip")
          response = gunzipSync(response, { maxOutputLength: LIMIT });
        else if (encoding && encoding !== "identity")
          throw new Error("unsupported-encoding");
        const frame = Buffer.alloc(4 + response.length);
        frame.writeUInt32BE(response.length);
        response.copy(frame, 4);
        process.stdout.write(frame, () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          client.close();
        });
      } catch {
        fail();
      }
    });
    stream.on("close", () => {
      if (!stream.readableEnded) fail();
    });
    stream.end(body);
  } catch {
    fail();
  }
});
