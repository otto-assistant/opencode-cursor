/**
 * Connection pool for persistent H2 bridge processes.
 *
 * Keeps a pool of long-lived Node.js child processes that maintain
 * HTTP/2 connections to Cursor's API, eliminating the ~300-500ms
 * overhead of spawning a new process per request.
 *
 * The pool pre-warms MIN_SIZE workers on startup. Workers are reused
 * across requests: after a stream completes, the worker returns to
 * the idle pool. Dead workers are replaced automatically.
 */
import { resolve as pathResolve } from "node:path";

const PERSISTENT_BRIDGE_PATH = pathResolve(import.meta.dir, "h2-bridge-persistent.mjs");

// --- Typed message protocol constants ---
const IN_NEW_REQUEST = 0x00;
const IN_WRITE = 0x01;
const IN_END_WRITES = 0x02;
const IN_SHUTDOWN = 0x03;

const OUT_DATA = 0x00;
const OUT_STREAM_DONE = 0x01;
// const OUT_ERROR = 0x02;

// --- Typed framing helpers ---

/** Encode a typed message: [4B len][1B type][payload] */
function encodeTyped(type: number, payload: Uint8Array): Buffer {
  const totalLen = 1 + payload.length;
  const buf = Buffer.alloc(4 + totalLen);
  buf.writeUInt32BE(totalLen, 0);
  buf[4] = type;
  if (payload.length > 0) buf.set(payload, 5);
  return buf;
}

// --- Worker ---

interface WorkerCallbacks {
  data: ((chunk: Buffer) => void) | null;
  streamDone: ((code: number) => void) | null;
}

interface PersistentWorker {
  proc: ReturnType<typeof Bun.spawn>;
  state: "idle" | "active" | "dead";
  cbs: WorkerCallbacks;
  /** True while the child process is still running. */
  alive: boolean;
}

function spawnWorker(): PersistentWorker {
  const proc = Bun.spawn(["node", PERSISTENT_BRIDGE_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });

  const worker: PersistentWorker = {
    proc,
    state: "idle",
    alive: true,
    cbs: { data: null, streamDone: null },
  };

  // Read stdout — parse typed messages
  (async () => {
    const reader = proc.stdout.getReader();
    let pending = Buffer.alloc(0);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending = Buffer.concat([pending, Buffer.from(value)]);

        while (pending.length >= 5) {
          const totalLen = pending.readUInt32BE(0);
          if (totalLen === 0) {
            pending = pending.subarray(4);
            continue;
          }
          if (pending.length < 4 + totalLen) break;

          const type = pending[4]!;
          const payload = pending.subarray(5, 4 + totalLen);
          pending = pending.subarray(4 + totalLen);

          if (type === OUT_DATA) {
            worker.cbs.data?.(Buffer.from(payload));
          } else if (type === OUT_STREAM_DONE) {
            const success = payload.length > 0 ? payload[0] === 0 : true;
            const cb = worker.cbs.streamDone;
            // Clear callbacks before firing — the worker is now idle
            worker.cbs.data = null;
            worker.cbs.streamDone = null;
            cb?.(success ? 0 : 1);
          }
          // OUT_ERROR is handled via process exit below
        }
      }
    } catch {
      // Stream ended
    }

    await proc.exited;
    worker.alive = false;
    worker.state = "dead";
    // Fire streamDone if we were mid-stream
    const cb = worker.cbs.streamDone;
    worker.cbs.data = null;
    worker.cbs.streamDone = null;
    cb?.(1);
  })();

  return worker;
}

function workerSend(worker: PersistentWorker, type: number, payload: Uint8Array): void {
  if (!worker.alive) return;
  try {
    const stdin = worker.proc.stdin as import("bun").FileSink;
    stdin.write(encodeTyped(type, payload));
  } catch {
    // stdin closed — worker is dying
  }
}

function workerSendNewRequest(worker: PersistentWorker, config: object): void {
  const configBytes = new TextEncoder().encode(JSON.stringify(config));
  workerSend(worker, IN_NEW_REQUEST, configBytes);
}

function workerSendWrite(worker: PersistentWorker, data: Uint8Array): void {
  workerSend(worker, IN_WRITE, data);
}

function workerSendEndWrites(worker: PersistentWorker): void {
  workerSend(worker, IN_END_WRITES, new Uint8Array(0));
}

function workerSendShutdown(worker: PersistentWorker): void {
  workerSend(worker, IN_SHUTDOWN, new Uint8Array(0));
}

function workerKill(worker: PersistentWorker): void {
  worker.state = "dead";
  worker.alive = false;
  try {
    worker.proc.kill();
  } catch {}
}

// --- Public handle interface (matches spawnBridge return type) ---

export interface BridgeHandle {
  write: (data: Uint8Array) => void;
  end: () => void;
  kill: () => void;
  onData: (cb: (chunk: Buffer) => void) => void;
  onClose: (cb: (code: number) => void) => void;
  /** True while the bridge stream is still active. */
  get alive(): boolean;
}

// --- Bridge Pool ---

export interface BridgePoolOptions {
  minSize?: number;
  maxSize?: number;
}

export interface BridgeAcquireOptions {
  accessToken: string;
  rpcPath: string;
  url?: string;
  unary?: boolean;
}

export class BridgePool {
  private idle: PersistentWorker[] = [];
  private allWorkers = new Set<PersistentWorker>();
  private readonly minSize: number;
  private readonly maxSize: number;
  private shuttingDown = false;

  constructor(options: BridgePoolOptions = {}) {
    this.minSize = options.minSize ?? 2;
    this.maxSize = options.maxSize ?? 4;
  }

  /** Pre-warm the pool with minSize idle workers. */
  warmup(): void {
    for (let i = 0; i < this.minSize; i++) {
      this.addWorker();
    }
  }

  /** Acquire a bridge handle for a new request. */
  acquire(options: BridgeAcquireOptions): BridgeHandle {
    if (this.shuttingDown) {
      throw new Error("BridgePool is shutting down");
    }

    let worker = this.idle.pop();
    if (!worker || !worker.alive) {
      // Try to find any alive idle worker
      while (this.idle.length > 0) {
        worker = this.idle.pop()!;
        if (worker.alive) break;
        this.allWorkers.delete(worker);
        worker = undefined;
      }
    }

    if (!worker) {
      if (this.allWorkers.size < this.maxSize) {
        worker = this.addWorker();
      } else {
        // Pool full — spawn an ephemeral worker not tracked by pool
        worker = spawnWorker();
        // Don't add to allWorkers — it won't be returned to pool
      }
    }

    worker.state = "active";
    const config = {
      accessToken: options.accessToken,
      url: options.url,
      path: options.rpcPath,
      unary: options.unary ?? false,
    };
    const handle = this.createHandle(worker);
    workerSendNewRequest(worker, config);

    return handle;
  }

  /** Shut down the pool, killing all workers. */
  shutdown(): void {
    this.shuttingDown = true;
    for (const worker of this.allWorkers) {
      workerSendShutdown(worker);
      // Give 500ms for graceful exit, then force kill
      setTimeout(() => {
        if (worker.alive) workerKill(worker);
      }, 500);
    }
    this.idle = [];
    this.allWorkers.clear();
  }

  /** Current pool stats for telemetry. */
  stats(): { idle: number; active: number; total: number; maxSize: number } {
    return {
      idle: this.idle.length,
      active: this.allWorkers.size - this.idle.length,
      total: this.allWorkers.size,
      maxSize: this.maxSize,
    };
  }

  private addWorker(): PersistentWorker {
    const worker = spawnWorker();
    this.allWorkers.add(worker);
    this.idle.push(worker);
    return worker;
  }

  private release(worker: PersistentWorker): void {
    if (this.shuttingDown || !worker.alive) {
      if (worker.alive) workerKill(worker);
      this.allWorkers.delete(worker);
      return;
    }

    worker.state = "idle";
    worker.cbs.data = null;
    worker.cbs.streamDone = null;

    if (this.allWorkers.has(worker)) {
      this.idle.push(worker);
    }

    // Replenish pool if below minSize
    this.replenish();
  }

  private remove(worker: PersistentWorker): void {
    this.allWorkers.delete(worker);
    const idx = this.idle.indexOf(worker);
    if (idx !== -1) this.idle.splice(idx, 1);
    if (worker.alive) workerKill(worker);

    // Replenish pool
    if (!this.shuttingDown) this.replenish();
  }

  private replenish(): void {
    while (this.idle.length < this.minSize && this.allWorkers.size < this.maxSize) {
      this.addWorker();
    }
  }

  private createHandle(worker: PersistentWorker): BridgeHandle {
    let done = false;
    /** Exit code recorded when STREAM_DONE/process-death completes before callers attach onClose. */
    let recordedExitCode = 0;
    const pool = this;
    const isPooled = this.allWorkers.has(worker);
    /** Buffer OUTPUT_DATA until the caller registers onData (stdout can beat ReadableStream wiring). */
    const pendingData: Buffer[] = [];
    let userDataCb: ((chunk: Buffer) => void) | null = null;

    worker.cbs.data = (chunk: Buffer) => {
      const copy = Buffer.from(chunk);
      if (userDataCb) userDataCb(copy);
      else pendingData.push(copy);
    };

    // When stream completes (bridge sends STREAM_DONE), fire onClose and return to pool
    const originalStreamDoneCb = worker.cbs.streamDone;
    let closeCb: ((code: number) => void) | null = null;

    worker.cbs.streamDone = (code: number) => {
      if (done) return;
      done = true;
      recordedExitCode = code;
      originalStreamDoneCb?.(code);
      const cbNow = closeCb;
      closeCb = null;
      cbNow?.(code);
      if (isPooled) {
        pool.release(worker);
      }
    };

    // Handle unexpected process death
    const checkDeath = () => {
      if (done || worker.alive) return;
      done = true;
      recordedExitCode = 1;
      const cbNow = closeCb;
      closeCb = null;
      cbNow?.(1);
      if (isPooled) {
        pool.remove(worker);
      }
    };

    return {
      get alive() {
        if (!worker.alive && !done) checkDeath();
        return !done && worker.alive;
      },
      write(data: Uint8Array) {
        workerSendWrite(worker, data);
      },
      end() {
        workerSendEndWrites(worker);
      },
      kill() {
        if (done) return;
        done = true;
        if (isPooled) {
          pool.remove(worker);
        } else {
          workerKill(worker);
        }
      },
      onData(cb: (chunk: Buffer) => void) {
        const flushed = pendingData.splice(0, pendingData.length);
        userDataCb = cb;
        for (const pending of flushed) cb(pending);
      },
      onClose(cb: (code: number) => void) {
        if (done) {
          queueMicrotask(() => cb(recordedExitCode));
        } else {
          closeCb = cb;
        }
      },
    };
  }
}
