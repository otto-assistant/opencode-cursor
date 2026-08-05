import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const BRIDGE_PATH = fileURLToPath(
  new URL("./h2-bridge-persistent.mjs", import.meta.url),
);
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_IPC_PAYLOAD_BYTES = 32 * 1024 * 1024;
const CLEANUP_ACK_MS = 750;
const MAX_TIMEOUT_MS = 2_147_483_647 - CLEANUP_ACK_MS;

const IN_REQUEST_CONFIG = 0x01;
const IN_REQUEST_BODY = 0x02;
const IN_CANCEL = 0x03;
const IN_PAUSE = 0x04;
const IN_RESUME = 0x05;
const IN_SHUTDOWN = 0x06;

const OUT_RESPONSE = 0x11;
const OUT_DATA = 0x12;
const OUT_TRAILERS = 0x13;
const OUT_DONE = 0x14;
const OUT_ERROR = 0x15;
const OUT_CANCELLED = 0x16;
const OUT_TIMEOUT = 0x17;
const OUT_FATAL = 0x18;

export type BridgeContentType =
  | "application/connect+proto"
  | "application/json"
  | "application/proto";

export interface BridgePoolRequest {
  accessToken: string;
  path: string;
  body: Uint8Array;
  url: string;
  contentType: BridgeContentType;
  connectProtocolVersion?: "1";
  timeoutMs: number;
  machineId: string;
}

export interface BridgePoolResponse {
  status: number;
  headers: Headers;
  trailers: Promise<Headers>;
  body: ReadableStream<Uint8Array>;
}

export interface BridgePoolOptions {
  minSize?: number;
  maxSize?: number;
}

interface WireRequestConfig {
  requestId: string;
  accessToken: string;
  path: string;
  bodyLength: number;
  url: string;
  contentType: BridgeContentType;
  connectProtocolVersion?: "1";
  timeoutMs: number;
  machineId: string;
}

type WorkerProcess = Bun.Subprocess<"pipe", "pipe", "ignore">;

interface PersistentWorker {
  proc: WorkerProcess;
  state: "idle" | "active" | "dead";
  alive: boolean;
  active?: PoolJob;
  writeChain: Promise<void>;
}

interface PoolJob {
  request: BridgePoolRequest;
  deadlineMs: number;
  requestId: Buffer;
  requestIdHex: string;
  state: "queued" | "active" | "terminal";
  worker?: PersistentWorker;
  resolveResponse: (response: BridgePoolResponse) => void;
  rejectResponse: (error: Error) => void;
  responseSettled: boolean;
  responseReceived: boolean;
  body: ReadableStream<Uint8Array>;
  bodyController: ReadableStreamDefaultController<Uint8Array>;
  bodyTerminated: boolean;
  trailers: Promise<Headers>;
  resolveTrailers: (headers: Headers) => void;
  rejectTrailers: (error: Error) => void;
  trailersSettled: boolean;
  paused: boolean;
  cancelling: boolean;
  signal?: AbortSignal;
  abortHandler?: () => void;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  timeoutWatchdog?: ReturnType<typeof setTimeout>;
}

function namedError(name: "AbortError" | "CursorTransportError" | "TimeoutError", message: string): Error {
  if (name === "AbortError") return new DOMException(message, name);
  const error = new Error(message);
  error.name = name;
  return error;
}

function transportError(): Error {
  return namedError("CursorTransportError", "Cursor HTTP/2 transport failed");
}

function timeoutError(): Error {
  return namedError("TimeoutError", "Cursor HTTP/2 request timed out");
}

function abortError(): Error {
  return namedError("AbortError", "The operation was aborted");
}

function encodeTyped(
  type: number,
  payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
): Buffer {
  if (payload.byteLength > MAX_IPC_PAYLOAD_BYTES) {
    throw new RangeError("IPC payload exceeds the 32 MiB limit");
  }
  const frame = Buffer.alloc(5 + payload.byteLength);
  frame.writeUInt32BE(1 + payload.byteLength, 0);
  frame[4] = type;
  frame.set(payload, 5);
  return frame;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHeaders(value: unknown): Headers {
  if (!Array.isArray(value)) throw transportError();
  const headers = new Headers();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) throw transportError();
    const name: unknown = entry[0];
    const headerValue: unknown = entry[1];
    if (typeof name !== "string" || typeof headerValue !== "string" || name.startsWith(":")) {
      throw transportError();
    }
    headers.append(name, headerValue);
  }
  return headers;
}

function parseResponse(payload: Uint8Array): { status: number; headers: Headers } {
  if (payload.byteLength > MAX_CONFIG_BYTES) throw transportError();
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw transportError();
  }
  if (!isRecord(value) || typeof value.status !== "number" || !Number.isInteger(value.status)) {
    throw transportError();
  }
  const status = value.status;
  if (status < 100 || status > 599) throw transportError();
  return { status, headers: parseHeaders(value.headers) };
}

function parseTrailers(payload: Uint8Array): Headers {
  if (payload.byteLength > MAX_CONFIG_BYTES) throw transportError();
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw transportError();
  }
  return parseHeaders(value);
}

function validatePoolSize(name: string, value: number, allowZero: boolean): void {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new RangeError(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
}

export class BridgePool {
  private readonly minSize: number;
  private readonly maxSize: number;
  private readonly idle: PersistentWorker[] = [];
  private readonly workers = new Set<PersistentWorker>();
  private readonly queue: PoolJob[] = [];
  private closing = false;

  constructor(options: BridgePoolOptions = {}) {
    this.minSize = options.minSize ?? 1;
    this.maxSize = options.maxSize ?? 4;
    validatePoolSize("minSize", this.minSize, true);
    validatePoolSize("maxSize", this.maxSize, false);
    if (this.minSize > this.maxSize) throw new RangeError("minSize cannot exceed maxSize");
  }

  warmup(): void {
    if (this.closing) return;
    while (this.workers.size < this.minSize) {
      if (!this.addWorker()) break;
    }
  }

  request(request: BridgePoolRequest, signal?: AbortSignal): Promise<BridgePoolResponse> {
    if (this.closing) return Promise.reject(transportError());
    if (request.body.byteLength > MAX_BODY_BYTES) {
      return Promise.reject(new RangeError("Request body exceeds the 32 MiB limit"));
    }
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > MAX_TIMEOUT_MS) {
      return Promise.reject(new RangeError("Request timeout is outside the supported range"));
    }
    if (signal?.aborted) return Promise.reject(abortError());

    return new Promise<BridgePoolResponse>((resolve, reject) => {
      let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
      let job: PoolJob;
      const trailersState: {
        resolve?: (headers: Headers) => void;
        reject?: (error: Error) => void;
      } = {};
      const trailers = new Promise<Headers>((resolveTrailers, rejectTrailers) => {
        trailersState.resolve = resolveTrailers;
        trailersState.reject = rejectTrailers;
      });
      void trailers.catch(() => {});
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
        },
        pull: () => this.resumeJob(job),
        cancel: () => this.cancelJob(job, true),
      });
      if (!bodyController || !trailersState.resolve || !trailersState.reject) {
        reject(transportError());
        return;
      }

      const requestId = randomBytes(16);
      job = {
        request,
        deadlineMs: performance.now() + request.timeoutMs,
        requestId,
        requestIdHex: requestId.toString("hex"),
        state: "queued",
        resolveResponse: resolve,
        rejectResponse: reject,
        responseSettled: false,
        responseReceived: false,
        body,
        bodyController,
        bodyTerminated: false,
        trailers,
        resolveTrailers: trailersState.resolve,
        rejectTrailers: trailersState.reject,
        trailersSettled: false,
        paused: false,
        cancelling: false,
        signal,
      };
      if (signal) {
        job.abortHandler = () => this.cancelJob(job, false);
        signal.addEventListener("abort", job.abortHandler, { once: true });
      }
      job.timeoutWatchdog = setTimeout(
        () => this.expireQueuedJob(job),
        request.timeoutMs,
      );
      this.queue.push(job);
      this.pump();
    });
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    const error = transportError();
    for (const job of this.queue.splice(0)) {
      this.failConsumer(job, error, false);
      this.finishJob(job);
    }
    this.idle.length = 0;
    for (const worker of this.workers) {
      if (worker.active) {
        this.failConsumer(worker.active, error, false);
        this.finishJob(worker.active);
      }
      void this.writeFrames(worker, [encodeTyped(IN_SHUTDOWN)]).catch(() => {});
      const timer = setTimeout(() => this.killWorker(worker), CLEANUP_ACK_MS);
      timer.unref?.();
    }
  }

  stats(): { idle: number; active: number; queued: number; total: number; maxSize: number } {
    let active = 0;
    for (const worker of this.workers) if (worker.state === "active") active += 1;
    return { idle: this.idle.length, active, queued: this.queue.length, total: this.workers.size, maxSize: this.maxSize };
  }

  private pump(): void {
    while (!this.closing && this.queue.length > 0) {
      let worker = this.idle.pop();
      while (worker && (!worker.alive || worker.state !== "idle")) worker = this.idle.pop();
      if (!worker) {
        if (this.workers.size >= this.maxSize) return;
        worker = this.addWorker();
        if (!worker) {
          const job = this.queue.shift();
          if (job) {
            this.failConsumer(job, transportError(), false);
            this.finishJob(job);
          }
          continue;
        }
        this.idle.pop();
      }

      const job = this.queue.shift();
      if (!job) {
        this.idle.push(worker);
        return;
      }
      if (job.signal?.aborted) {
        this.idle.push(worker);
        this.cancelJob(job, false);
        continue;
      }
      this.startJob(worker, job);
    }
  }

  private startJob(worker: PersistentWorker, job: PoolJob): void {
    worker.state = "active";
    worker.active = job;
    job.state = "active";
    job.worker = worker;
    if (job.timeoutWatchdog) {
      clearTimeout(job.timeoutWatchdog);
      job.timeoutWatchdog = undefined;
    }
    const remainingMs = Math.ceil(job.deadlineMs - performance.now());
    if (remainingMs <= 0) {
      this.failConsumer(job, timeoutError(), false);
      this.releaseWorker(worker, job);
      return;
    }

    const config: WireRequestConfig = {
      requestId: job.requestIdHex,
      accessToken: job.request.accessToken,
      path: job.request.path,
      bodyLength: job.request.body.byteLength,
      url: job.request.url,
      contentType: job.request.contentType,
      connectProtocolVersion: job.request.connectProtocolVersion,
      timeoutMs: remainingMs,
      machineId: job.request.machineId,
    };
    const configBytes = new TextEncoder().encode(JSON.stringify(config));
    if (configBytes.byteLength > MAX_CONFIG_BYTES) {
      this.failConsumer(job, new RangeError("Request configuration exceeds the 64 KiB limit"), false);
      this.releaseWorker(worker, job);
      return;
    }

    job.timeoutWatchdog = setTimeout(() => {
      if (job.state !== "active") return;
      this.failConsumer(job, timeoutError(), false);
      this.failWorker(worker);
    }, remainingMs + CLEANUP_ACK_MS);
    void this.writeFrames(worker, [
      encodeTyped(IN_REQUEST_CONFIG, configBytes),
      encodeTyped(IN_REQUEST_BODY, job.request.body),
    ]).catch(() => this.failWorker(worker));
  }

  private addWorker(): PersistentWorker | undefined {
    let proc: WorkerProcess;
    try {
      proc = Bun.spawn({
        cmd: ["node", BRIDGE_PATH],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
    } catch {
      return undefined;
    }
    const worker: PersistentWorker = {
      proc,
      state: "idle",
      alive: true,
      writeChain: Promise.resolve(),
    };
    this.workers.add(worker);
    this.idle.push(worker);
    void this.readWorker(worker);
    return worker;
  }

  private async readWorker(worker: PersistentWorker): Promise<void> {
    const reader = worker.proc.stdout.getReader();
    let pending = Buffer.alloc(0);
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        pending = Buffer.concat([pending, Buffer.from(result.value)]);
        while (pending.byteLength >= 4) {
          const length = pending.readUInt32BE(0);
          if (length < 1 || length > MAX_IPC_PAYLOAD_BYTES + 1) throw transportError();
          if (pending.byteLength < 4 + length) break;
          const type = pending[4];
          if (type === undefined) throw transportError();
          const payload = pending.subarray(5, 4 + length);
          pending = pending.subarray(4 + length);
          this.handleWorkerMessage(worker, type, payload);
        }
      }
      if (pending.byteLength !== 0) throw transportError();
    } catch {
      this.failWorker(worker);
    } finally {
      reader.releaseLock();
    }
    await worker.proc.exited.catch(() => -1);
    this.failWorker(worker);
  }

  private handleWorkerMessage(worker: PersistentWorker, type: number, payload: Buffer): void {
    if (type === OUT_FATAL) {
      this.failWorker(worker);
      return;
    }
    const job = worker.active;
    if (!job || payload.byteLength < 16 || !payload.subarray(0, 16).equals(job.requestId)) {
      this.failWorker(worker);
      return;
    }
    const content = payload.subarray(16);
    try {
      if (type === OUT_RESPONSE) this.receiveResponse(job, parseResponse(content));
      else if (type === OUT_DATA) this.receiveData(job, content);
      else if (type === OUT_TRAILERS) this.receiveTrailers(job, parseTrailers(content));
      else if (type === OUT_DONE) this.receiveResult(worker, job, undefined);
      else if (type === OUT_ERROR) this.receiveResult(worker, job, transportError());
      else if (type === OUT_CANCELLED) this.receiveResult(worker, job, abortError());
      else if (type === OUT_TIMEOUT) this.receiveResult(worker, job, timeoutError());
      else this.failWorker(worker);
    } catch {
      this.failWorker(worker);
    }
  }

  private receiveResponse(job: PoolJob, response: { status: number; headers: Headers }): void {
    if (job.responseReceived) throw transportError();
    job.responseReceived = true;
    if (!job.responseSettled) {
      job.responseSettled = true;
      job.resolveResponse({ status: response.status, headers: response.headers, trailers: job.trailers, body: job.body });
    }
  }

  private receiveData(job: PoolJob, content: Buffer): void {
    if (!job.responseReceived) throw transportError();
    if (job.bodyTerminated) return;
    job.bodyController.enqueue(new Uint8Array(content));
    if ((job.bodyController.desiredSize ?? 1) <= 0 && !job.paused) {
      job.paused = true;
      this.sendControl(job, IN_PAUSE);
    }
  }

  private receiveTrailers(job: PoolJob, headers: Headers): void {
    if (!job.responseReceived || job.trailersSettled) throw transportError();
    job.trailersSettled = true;
    job.resolveTrailers(headers);
  }

  private receiveResult(worker: PersistentWorker, job: PoolJob, error: Error | undefined): void {
    if (error) this.failConsumer(job, error, false);
    else if (!job.responseReceived) this.failConsumer(job, transportError(), false);
    else {
      if (!job.bodyTerminated) {
        job.bodyTerminated = true;
        job.bodyController.close();
      }
      if (!job.trailersSettled) {
        job.trailersSettled = true;
        job.resolveTrailers(new Headers());
      }
    }
    this.releaseWorker(worker, job);
  }

  private cancelJob(job: PoolJob, bodyAlreadyCancelled: boolean): void {
    if (job.state === "terminal" || job.cancelling) return;
    job.cancelling = true;
    const error = abortError();
    if (job.state === "queued") {
      const index = this.queue.indexOf(job);
      if (index >= 0) this.queue.splice(index, 1);
      this.failConsumer(job, error, bodyAlreadyCancelled);
      this.finishJob(job);
      return;
    }
    this.failConsumer(job, error, bodyAlreadyCancelled);
    this.sendControl(job, IN_CANCEL);
    job.cleanupTimer = setTimeout(() => {
      if (job.state === "active" && job.worker) this.failWorker(job.worker);
    }, CLEANUP_ACK_MS);
  }

  private expireQueuedJob(job: PoolJob): void {
    if (job.state !== "queued") return;
    const index = this.queue.indexOf(job);
    if (index >= 0) this.queue.splice(index, 1);
    this.failConsumer(job, timeoutError(), false);
    this.finishJob(job);
    this.pump();
  }

  private resumeJob(job: PoolJob): void {
    if (job.state !== "active" || !job.paused) return;
    job.paused = false;
    this.sendControl(job, IN_RESUME);
  }

  private sendControl(job: PoolJob, type: number): void {
    const worker = job.worker;
    if (!worker?.alive || worker.active !== job) return;
    void this.writeFrames(worker, [encodeTyped(type, job.requestId)]).catch(() => this.failWorker(worker));
  }

  private failConsumer(job: PoolJob, error: Error, bodyAlreadyCancelled: boolean): void {
    if (!job.responseSettled) {
      job.responseSettled = true;
      job.rejectResponse(error);
    }
    if (!job.bodyTerminated) {
      job.bodyTerminated = true;
      if (!bodyAlreadyCancelled) job.bodyController.error(error);
    }
    if (!job.trailersSettled) {
      job.trailersSettled = true;
      job.rejectTrailers(error);
    }
  }

  private releaseWorker(worker: PersistentWorker, job: PoolJob): void {
    if (worker.active !== job) return;
    this.finishJob(job);
    worker.active = undefined;
    if (!worker.alive || this.closing) {
      this.killWorker(worker);
      return;
    }
    worker.state = "idle";
    this.idle.push(worker);
    this.ensureMinimum();
    this.pump();
  }

  private finishJob(job: PoolJob): void {
    job.state = "terminal";
    if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
    if (job.timeoutWatchdog) clearTimeout(job.timeoutWatchdog);
    if (job.signal && job.abortHandler) job.signal.removeEventListener("abort", job.abortHandler);
  }

  private failWorker(worker: PersistentWorker): void {
    if (!worker.alive && !this.workers.has(worker)) return;
    worker.alive = false;
    worker.state = "dead";
    const active = worker.active;
    worker.active = undefined;
    if (active) {
      this.failConsumer(active, active.cancelling ? abortError() : transportError(), false);
      this.finishJob(active);
    }
    const idleIndex = this.idle.indexOf(worker);
    if (idleIndex >= 0) this.idle.splice(idleIndex, 1);
    this.workers.delete(worker);
    this.killWorker(worker);
    if (!this.closing) {
      this.ensureMinimum();
      this.pump();
    }
  }

  private killWorker(worker: PersistentWorker): void {
    worker.alive = false;
    worker.state = "dead";
    try {
      worker.proc.kill();
    } catch {}
  }

  private ensureMinimum(): void {
    while (!this.closing && this.workers.size < this.minSize) {
      if (!this.addWorker()) break;
    }
  }

  private writeFrames(worker: PersistentWorker, frames: Buffer[]): Promise<void> {
    const write = worker.writeChain.then(async () => {
      if (!worker.alive) throw transportError();
      for (const frame of frames) await worker.proc.stdin.write(frame);
      await worker.proc.stdin.flush();
    });
    worker.writeChain = write.catch(() => {});
    return write;
  }
}
