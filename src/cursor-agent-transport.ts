import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveNodeExecutable } from "./node-runtime.js";

const LIMIT = 8 * 1024 * 1024;

export function startAgentTransport(input: {
  accessToken: string;
  url: string;
  tools: boolean;
  onMessage: (bytes: Uint8Array) => void;
  onEnd: (error?: Error) => void;
}) {
  const worker = spawn(
    resolveNodeExecutable(),
    [fileURLToPath(new URL("./h2-v2.mjs", import.meta.url))],
    {
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  let done = false;
  let pending = Buffer.alloc(0);
  const stop = (error?: Error) => {
    if (done) return;
    done = true;
    worker.kill();
    input.onEnd(error);
  };
  const write = (type: number, data: Uint8Array = new Uint8Array()) => {
    if (done) throw new Error("Cursor transport is closed");
    if (data.byteLength > LIMIT || worker.stdin.writableLength > LIMIT * 2) {
      throw new Error("Cursor transport write capacity exceeded");
    }
    const header = Buffer.alloc(5);
    header[0] = type;
    header.writeUInt32BE(data.byteLength, 1);
    worker.stdin.write(Buffer.concat([header, data]));
  };
  worker.stdin.on("error", () =>
    stop(new Error("Cursor transport input closed")),
  );
  worker.on("error", () =>
    stop(new Error("Cursor Node transport could not start")),
  );
  worker.on("close", (code) =>
    stop(new Error(`Cursor Node transport exited before completion (${code})`)),
  );
  worker.stdout.on("data", (chunk: Buffer) => {
    if (done) return;
    try {
      pending = Buffer.concat([pending, chunk]);
      while (!done && pending.length >= 5) {
        const type = pending[0];
        const size = pending.readUInt32BE(1);
        if (size > LIMIT)
          throw new Error("Cursor transport frame capacity exceeded");
        if (pending.length < size + 5) break;
        const bytes = pending.subarray(5, size + 5);
        pending = pending.subarray(size + 5);
        if (type === 0) input.onMessage(bytes);
        else if (type === 1 && size === 0) stop();
        else if (type === 2)
          stop(new Error(`Cursor transport: ${bytes.toString()}`));
        else throw new Error("Invalid Cursor transport response");
      }
    } catch (error) {
      stop(
        error instanceof Error
          ? error
          : new Error("Invalid Cursor transport response"),
      );
    }
  });
  write(
    0,
    Buffer.from(
      JSON.stringify({
        accessToken: input.accessToken,
        url: input.url,
        tools: input.tools,
      }),
    ),
  );
  return {
    send: (bytes: Uint8Array) => write(1, bytes),
    cancel: () => {
      if (!done) {
        done = true;
        worker.kill();
      }
    },
  };
}
