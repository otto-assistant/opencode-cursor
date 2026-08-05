import { describe, expect, test } from "bun:test";
import http2 from "node:http2";
import type {
  Http2Stream,
  IncomingHttpHeaders,
  ServerHttp2Session,
  ServerHttp2Stream,
} from "node:http2";
import {
  UnifiedChatTransport,
  collectTransportBody,
  type CursorTransportResponse,
} from "../src/unified-chat-transport";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TEST_TOKEN = "synthetic-access-token";
const TEST_MACHINE_ID = "0123456789abcdef0123456789abcdef";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type StreamHandler = (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => void;

interface TestServer {
  url: string;
  connectionCount: () => number;
  close: () => Promise<void>;
}

function isServerStream(stream: Http2Stream): stream is ServerHttp2Stream {
  return "respond" in stream && typeof stream.respond === "function";
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

async function createTestServer(handler: StreamHandler): Promise<TestServer> {
  const sessions = new Set<ServerHttp2Session>();
  let connections = 0;
  const server = http2.createServer();

  server.on("session", (session) => {
    connections += 1;
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });
  server.on("stream", (stream, headers) => {
    stream.on("error", () => {});
    if (!isServerStream(stream)) {
      stream.destroy();
      return;
    }
    handler(stream, headers);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Test HTTP/2 server did not bind to a TCP address");
  }
  const port = address.port;
  return {
    url: `http://127.0.0.1:${port}`,
    connectionCount: () => connections,
    close: async () => {
      for (const session of sessions) session.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function withTransport(
  handler: StreamHandler,
  options: { minSize?: number; maxSize?: number } | undefined,
  run: (transport: UnifiedChatTransport, server: TestServer) => Promise<void>,
): Promise<void> {
  const server = await createTestServer(handler);
  const transport = new UnifiedChatTransport({
    minSize: options?.minSize ?? 1,
    maxSize: options?.maxSize ?? 1,
    url: server.url,
    machineId: TEST_MACHINE_ID,
  });
  try {
    await run(transport, server);
  } finally {
    transport.close();
    await server.close();
  }
}

function readRequestBody(stream: ServerHttp2Stream): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.once("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    stream.once("error", reject);
  });
}

function respondText(stream: ServerHttp2Stream, text = "ok"): void {
  stream.respond({ ":status": 200, "content-type": "text/plain" });
  stream.end(text);
}

async function responseText(response: CursorTransportResponse): Promise<string> {
  return decoder.decode(await collectTransportBody(response));
}

describe("UnifiedChatTransport", () => {
  test("sends IDE headers and streams status, chunks, and trailers", async () => {
    let observedHeaders: IncomingHttpHeaders | undefined;
    let observedBody: Promise<Uint8Array> | undefined;

    await withTransport(
      (stream, headers) => {
        observedHeaders = headers;
        observedBody = readRequestBody(stream);
        stream.on("wantTrailers", () => {
          stream.sendTrailers({ "x-test-trailer": "complete" });
        });
        stream.respond(
          {
            ":status": 207,
            "content-type": "application/connect+proto",
            "x-test-response": "present",
          },
          { waitForTrailers: true },
        );
        stream.write("first");
        setTimeout(() => stream.write("second"), 20);
        setTimeout(() => stream.end("third"), 40);
      },
      undefined,
      async (transport) => {
        const response = await transport.request({
          accessToken: TEST_TOKEN,
          path: "/aiserver.v1.ChatService/StreamUnifiedChatWithTools?test=1",
          body: encoder.encode("request-body"),
        });

        expect(response.status).toBe(207);
        expect(response.headers.get("x-test-response")).toBe("present");
        const reader = response.body.getReader();
        const first = await reader.read();
        expect(first.done).toBe(false);
        expect(decoder.decode(first.value)).toBe("first");

        const remaining: Uint8Array[] = [];
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          remaining.push(chunk.value);
        }
        expect(remaining.map((chunk) => decoder.decode(chunk)).join(""))
          .toBe("secondthird");
        expect((await response.trailers).get("x-test-trailer")).toBe("complete");
        expect(decoder.decode(await observedBody)).toBe("request-body");

        expect(observedHeaders?.[":path"]).toBe(
          "/aiserver.v1.ChatService/StreamUnifiedChatWithTools?test=1",
        );
        expect(observedHeaders?.["content-type"]).toBe("application/connect+proto");
        expect(observedHeaders?.accept).toBe("application/connect+proto");
        expect(observedHeaders?.["accept-encoding"]).toBe("gzip");
        expect(observedHeaders?.["connect-protocol-version"]).toBe("1");
        expect(observedHeaders?.authorization).toMatch(/^Bearer \S+$/);
        expect(observedHeaders?.["x-client-key"]).toMatch(/^[0-9a-f]{64}$/);
        expect(observedHeaders?.["x-cursor-checksum"]).toBeString();
        expect(observedHeaders?.["x-cursor-client-version"]).toBe("3.1.0");
        expect(observedHeaders?.["x-cursor-client-type"]).toBe("ide");
        expect(observedHeaders?.["x-cursor-client-os"]).toMatch(/^(linux|macos|windows)$/);
        expect(observedHeaders?.["x-cursor-client-arch"]).toBeString();
        expect(observedHeaders?.["x-cursor-client-device-type"]).toBe("desktop");
        expect(observedHeaders?.["x-ghost-mode"]).toBe("false");
        expect(observedHeaders?.["x-new-onboarding-completed"]).toBe("true");
        expect(observedHeaders?.["x-session-id"]).toMatch(UUID_PATTERN);
        expect(observedHeaders?.["x-request-id"]).toMatch(UUID_PATTERN);
        expect(observedHeaders?.["x-cursor-config-version"]).toMatch(UUID_PATTERN);
      },
    );
  });

  test("uses appropriate discovery content types and reuses one connection", async () => {
    const observations: IncomingHttpHeaders[] = [];
    await withTransport(
      (stream, headers) => {
        observations.push(headers);
        respondText(stream);
      },
      undefined,
      async (transport, server) => {
        const json = await transport.request({
          accessToken: TEST_TOKEN,
          path: "/json",
          body: encoder.encode("{}"),
          contentType: "application/json",
        });
        expect(await responseText(json)).toBe("ok");

        const proto = await transport.request({
          accessToken: TEST_TOKEN,
          path: "/proto",
          body: encoder.encode("proto"),
          contentType: "application/proto",
        });
        expect(await responseText(proto)).toBe("ok");

        expect(observations.map((headers) => headers["content-type"]))
          .toEqual(["application/json", "application/proto"]);
        expect(observations.map((headers) => headers.accept))
          .toEqual(["application/json", "application/proto"]);
        expect(observations.every((headers) => headers["connect-protocol-version"] === undefined))
          .toBe(true);
        expect(observations.every((headers) => headers["x-cursor-client-type"] === "ide"))
          .toBe(true);
        expect(server.connectionCount()).toBe(1);
      },
    );
  });

  test("queues concurrent requests at maxSize", async () => {
    let active = 0;
    let maximumActive = 0;
    await withTransport(
      (stream) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        setTimeout(() => {
          respondText(stream);
          active -= 1;
        }, 35);
      },
      { minSize: 0, maxSize: 2 },
      async (transport, server) => {
        const requests = Array.from({ length: 6 }, async (_, index) => {
          const response = await transport.request({
            accessToken: TEST_TOKEN,
            path: `/concurrent/${index}`,
            body: new Uint8Array(),
          });
          return responseText(response);
        });
        expect(await Promise.all(requests)).toEqual(Array(6).fill("ok"));
        expect(maximumActive).toBe(2);
        expect(server.connectionCount()).toBe(2);
      },
    );
  });

  test("times out a request while it is still queued", async () => {
    await withTransport(
      (stream, headers) => {
        stream.resume();
        if (headers[":path"] === "/hold") {
          setTimeout(() => respondText(stream, "released"), 200);
          return;
        }
        respondText(stream, "should-not-run");
      },
      { minSize: 0, maxSize: 1 },
      async (transport) => {
        const first = transport.request({
          accessToken: TEST_TOKEN,
          path: "/hold",
          body: new Uint8Array(),
          timeoutMs: 1_000,
        });
        await Bun.sleep(30);
        const startedAt = Date.now();
        const queued = transport.request({
          accessToken: TEST_TOKEN,
          path: "/queued-timeout",
          body: new Uint8Array(),
          timeoutMs: 60,
        });

        await expect(queued).rejects.toHaveProperty("name", "TimeoutError");
        expect(Date.now() - startedAt).toBeLessThan(180);
        expect(await responseText(await first)).toBe("released");
      },
    );
  });

  test("cancels an active stream and recovers the worker", async () => {
    const cancelled = deferred();
    await withTransport(
      (stream, headers) => {
        if (headers[":path"] === "/cancel") {
          stream.once("close", cancelled.resolve);
          stream.respond({ ":status": 200, "content-type": "text/plain" });
          stream.write("started");
          return;
        }
        respondText(stream, "recovered");
      },
      undefined,
      async (transport, server) => {
        const controller = new AbortController();
        const response = await transport.request({
          accessToken: TEST_TOKEN,
          path: "/cancel",
          body: new Uint8Array(),
          signal: controller.signal,
        });
        const trailerError = response.trailers.catch((error: unknown) => error);
        const reader = response.body.getReader();
        expect(decoder.decode((await reader.read()).value)).toBe("started");
        controller.abort();
        await expect(reader.read()).rejects.toHaveProperty("name", "AbortError");
        expect(await trailerError).toHaveProperty("name", "AbortError");
        await cancelled.promise;

        const recovery = await transport.request({
          accessToken: TEST_TOKEN,
          path: "/recover",
          body: new Uint8Array(),
        });
        expect(await responseText(recovery)).toBe("recovered");
        expect(server.connectionCount()).toBe(1);
      },
    );
  });

  test("reports timeout distinctly and recovers the worker", async () => {
    const timedOut = deferred();
    await withTransport(
      (stream, headers) => {
        if (headers[":path"] === "/timeout") {
          stream.once("close", timedOut.resolve);
          return;
        }
        respondText(stream, "after-timeout");
      },
      undefined,
      async (transport, server) => {
        await expect(transport.request({
          accessToken: TEST_TOKEN,
          path: "/timeout",
          body: new Uint8Array(),
          timeoutMs: 40,
        })).rejects.toHaveProperty("name", "TimeoutError");
        await timedOut.promise;

        const recovery = await transport.request({
          accessToken: TEST_TOKEN,
          path: "/recover-timeout",
          body: new Uint8Array(),
        });
        expect(await responseText(recovery)).toBe("after-timeout");
        expect(server.connectionCount()).toBe(1);
      },
    );
  });

  test("rejects a closed response as a transport error and reconnects", async () => {
    await withTransport(
      (stream, headers) => {
        if (headers[":path"] === "/closed") {
          stream.session?.destroy();
          return;
        }
        respondText(stream, "reconnected");
      },
      undefined,
      async (transport, server) => {
        await expect(transport.request({
          accessToken: TEST_TOKEN,
          path: "/closed",
          body: new Uint8Array(),
        })).rejects.toHaveProperty("name", "CursorTransportError");

        const recovery = await transport.request({
          accessToken: TEST_TOKEN,
          path: "/after-close",
          body: new Uint8Array(),
        });
        expect(await responseText(recovery)).toBe("reconnected");
        expect(server.connectionCount()).toBe(2);
      },
    );
  });

  test("enforces collection bounds and cancels the oversized response", async () => {
    await withTransport(
      (stream, headers) => {
        if (headers[":path"] === "/large") {
          stream.respond({ ":status": 200, "content-type": "text/plain" });
          stream.write("1234");
          setTimeout(() => stream.end("5678"), 20);
          return;
        }
        respondText(stream, "bounded-recovery");
      },
      undefined,
      async (transport) => {
        const response = await transport.request({
          accessToken: TEST_TOKEN,
          path: "/large",
          body: new Uint8Array(),
        });
        void response.trailers.catch(() => {});
        await expect(collectTransportBody(response, 6)).rejects.toBeInstanceOf(RangeError);

        const recovery = await transport.request({
          accessToken: TEST_TOKEN,
          path: "/after-bound",
          body: new Uint8Array(),
        });
        expect(await responseText(recovery)).toBe("bounded-recovery");

        const exact: CursorTransportResponse = {
          status: 200,
          headers: new Headers(),
          trailers: Promise.resolve(new Headers()),
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("123"));
              controller.enqueue(encoder.encode("45"));
              controller.close();
            },
          }),
        };
        expect(decoder.decode(await collectTransportBody(exact, 5))).toBe("12345");
      },
    );
  });
});
