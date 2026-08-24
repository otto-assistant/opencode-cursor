import { resolve as pathResolve } from "node:path";

export const CURSOR_API_URL =
  process.env.CURSOR_API_URL ?? "https://api2.cursor.sh";
export const BRIDGE_PATH = pathResolve(import.meta.dir, "h2-bridge.mjs");

function lpEncode(data: Uint8Array): Buffer {
  const buffer = Buffer.alloc(4 + data.length);
  buffer.writeUInt32BE(data.length, 0);
  buffer.set(data, 4);
  return buffer;
}

interface CursorUnaryRpcOptions {
  accessToken: string;
  rpcPath: string;
  requestBody: Uint8Array;
  url?: string;
  timeoutMs?: number;
  contentType?: "application/proto" | "application/json";
  connectProtocolVersion?: "1";
}

function spawnBridge(options: CursorUnaryRpcOptions) {
  const proc = Bun.spawn(["node", BRIDGE_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  proc.stdin.write(
    lpEncode(
      new TextEncoder().encode(
        JSON.stringify({
          accessToken: options.accessToken,
          url: options.url ?? CURSOR_API_URL,
          path: options.rpcPath,
          unary: true,
          contentType: options.contentType,
          connectProtocolVersion: options.connectProtocolVersion,
        }),
      ),
    ),
  );
  return proc;
}

export async function callCursorUnaryRpc(
  options: CursorUnaryRpcOptions,
): Promise<{ body: Uint8Array; exitCode: number; timedOut: boolean }> {
  const proc = spawnBridge(options);
  let timedOut = false;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const timeout =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          try {
            proc.kill();
          } catch {}
        }, timeoutMs)
      : undefined;

  proc.stdin.write(lpEncode(options.requestBody));
  proc.stdin.write(lpEncode(new Uint8Array(0)));
  proc.stdin.end();

  const chunks: Buffer[] = [];
  const reader = proc.stdout.getReader();
  let pending = Buffer.alloc(0);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending = Buffer.concat([pending, Buffer.from(value)]);
      while (pending.length >= 4) {
        const length = pending.readUInt32BE(0);
        if (pending.length < 4 + length) break;
        chunks.push(Buffer.from(pending.subarray(4, 4 + length)));
        pending = pending.subarray(4 + length);
      }
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  return {
    body: Buffer.concat(chunks),
    exitCode: (await proc.exited) ?? 1,
    timedOut,
  };
}
