import { afterEach, expect, test } from "bun:test";
import http2 from "node:http2";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { callCursorUnaryRpc } from "../src/cursor-rpc";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function server(
  reply: (
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
  ) => void,
) {
  const backend = http2.createServer();
  backend.on("stream", (stream, headers) => {
    stream.on("error", () => {});
    reply(stream, headers);
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => backend.close(() => resolve())));
  return `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
}
test("unary catalog worker preserves authenticated JSON requests and gzip responses", async () => {
  const url = await server((stream, headers) => {
    expect(headers.authorization).toBe("Bearer synthetic");
    expect(headers[":path"]).toBe("/catalog");
    expect(headers["connect-protocol-version"]).toBe("1");
    let body = "";
    stream.on("data", (data) => {
      body += data;
    });
    stream.on("end", () => {
      expect(body).toBe('{"models":[]}');
      stream.respond({ ":status": 200, "content-encoding": "gzip" });
      stream.end(gzipSync('{"models":["exact"]}'));
    });
  });
  const result = await callCursorUnaryRpc({
    url,
    accessToken: "synthetic",
    rpcPath: "/catalog",
    contentType: "application/json",
    connectProtocolVersion: "1",
    requestBody: Buffer.from('{"models":[]}'),
  });
  expect(result.exitCode).toBe(0);
  expect(Buffer.from(result.body).toString()).toBe('{"models":["exact"]}');
});
test("unary errors and timeouts cannot be mistaken for a successful catalog", async () => {
  for (const status of [401, 200]) {
    const url = await server((stream) => {
      stream.respond({ ":status": status });
      if (status === 401) stream.end("private remote diagnostic");
    });
    const result = await callCursorUnaryRpc({
      url,
      accessToken: "synthetic",
      rpcPath: "/catalog",
      requestBody: new Uint8Array(),
      timeoutMs: status === 200 ? 150 : 1000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.body.length).toBe(0);
    expect(result.timedOut).toBe(status === 200);
  }
});

test("an HTTP success with a failing RPC status is rejected", async () => {
  const url = await server((stream) => {
    stream.respond({ ":status": 200, "grpc-status": "7" });
    stream.end('{"models":["not-a-success"]}');
  });
  const result = await callCursorUnaryRpc({
    url,
    accessToken: "synthetic",
    rpcPath: "/catalog",
    requestBody: new Uint8Array(),
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.body.length).toBe(0);
});
