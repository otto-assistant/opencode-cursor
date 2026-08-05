#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import http2 from "node:http2";

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_IPC_PAYLOAD_BYTES = 32 * 1024 * 1024;
const MAX_DATA_BYTES = MAX_IPC_PAYLOAD_BYTES - 16;
const IDLE_CONNECTION_TIMEOUT_MS = 5 * 60 * 1000;
const STREAM_CLEANUP_GRACE_MS = 250;
const CONTENT_TYPES = new Set([
  "application/connect+proto",
  "application/json",
  "application/proto",
]);

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

const CLIENT_VERSION = "3.1.0";
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const CONFIG_KEYS = new Set([
  "requestId",
  "accessToken",
  "path",
  "bodyLength",
  "url",
  "contentType",
  "connectProtocolVersion",
  "timeoutMs",
  "machineId",
]);

let stdinBuffer = Buffer.alloc(0);
let stdinResolve;
let stdinEnded = false;
let pendingConfig;
let active;
let client;
let clientOrigin;
let idleTimer;
let shuttingDown = false;

function frame(type, payload) {
  if (payload.length > MAX_IPC_PAYLOAD_BYTES) throw new Error("IPC protocol error");
  const output = Buffer.alloc(5 + payload.length);
  output.writeUInt32BE(1 + payload.length, 0);
  output[4] = type;
  output.set(payload, 5);
  return output;
}

function writeTyped(type, payload = Buffer.alloc(0)) {
  return process.stdout.write(frame(type, payload));
}

function writeForRequest(request, type, content = Buffer.alloc(0)) {
  return writeTyped(type, Buffer.concat([request.id, content]));
}

function sendFatalAndExit() {
  if (shuttingDown) return;
  shuttingDown = true;
  const output = frame(OUT_FATAL, Buffer.from("Bridge protocol failure", "utf8"));
  process.stdout.write(output, () => process.exit(1));
}

process.stdin.on("data", (chunk) => {
  stdinBuffer = Buffer.concat([stdinBuffer, Buffer.from(chunk)]);
  if (stdinResolve) {
    const resolve = stdinResolve;
    stdinResolve = undefined;
    resolve();
  }
});

process.stdin.on("end", () => {
  stdinEnded = true;
  if (stdinResolve) {
    const resolve = stdinResolve;
    stdinResolve = undefined;
    resolve();
  }
});

function waitForStdin() {
  return new Promise((resolve) => {
    stdinResolve = resolve;
  });
}

async function readExact(length) {
  while (stdinBuffer.length < length) {
    if (stdinEnded) return undefined;
    await waitForStdin();
  }
  const value = Buffer.from(stdinBuffer.subarray(0, length));
  stdinBuffer = stdinBuffer.subarray(length);
  return value;
}

async function readTyped() {
  const lengthBytes = await readExact(4);
  if (!lengthBytes) return undefined;
  const length = lengthBytes.readUInt32BE(0);
  if (length < 1 || length > MAX_IPC_PAYLOAD_BYTES + 1) throw new Error("IPC protocol error");
  const value = await readExact(length);
  if (!value) throw new Error("IPC protocol error");
  return { type: value[0], payload: value.subarray(1) };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfig(payload) {
  if (payload.length > MAX_CONFIG_BYTES) throw new Error("IPC protocol error");
  let value;
  try {
    value = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new Error("IPC protocol error");
  }
  if (!isPlainObject(value) || Object.keys(value).some((key) => !CONFIG_KEYS.has(key))) {
    throw new Error("IPC protocol error");
  }
  if (typeof value.requestId !== "string" || !/^[0-9a-f]{32}$/.test(value.requestId)) {
    throw new Error("IPC protocol error");
  }
  if (typeof value.accessToken !== "string" || value.accessToken.length === 0 || /[\r\n]/.test(value.accessToken)) {
    throw new Error("IPC protocol error");
  }
  if (typeof value.path !== "string" || !value.path.startsWith("/") || value.path.length > 16 * 1024 || /[\r\n]/.test(value.path)) {
    throw new Error("IPC protocol error");
  }
  if (!Number.isInteger(value.bodyLength) || value.bodyLength < 0 || value.bodyLength > MAX_BODY_BYTES) {
    throw new Error("IPC protocol error");
  }
  if (typeof value.url !== "string" || typeof value.contentType !== "string" || !CONTENT_TYPES.has(value.contentType)) {
    throw new Error("IPC protocol error");
  }
  if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 2_147_483_647) {
    throw new Error("IPC protocol error");
  }
  if (typeof value.machineId !== "string" || value.machineId.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(value.machineId)) {
    throw new Error("IPC protocol error");
  }
  if (value.connectProtocolVersion !== undefined && value.connectProtocolVersion !== "1") {
    throw new Error("IPC protocol error");
  }
  let url;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error("IPC protocol error");
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("IPC protocol error");
  }
  return {
    ...value,
    id: Buffer.from(value.requestId, "hex"),
    origin: url.origin,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function uuidV5Dns(value) {
  const namespace = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
  const digest = createHash("sha1").update(namespace).update(value).digest().subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

function cursorChecksum(machineId) {
  const timestamp = Math.floor(Date.now() / 1_000_000);
  const bytes = Buffer.from([
    Math.floor(timestamp / 2 ** 40) & 0xff,
    Math.floor(timestamp / 2 ** 32) & 0xff,
    (timestamp >>> 24) & 0xff,
    (timestamp >>> 16) & 0xff,
    (timestamp >>> 8) & 0xff,
    timestamp & 0xff,
  ]);
  let previous = 165;
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = ((bytes[index] ^ previous) + (index & 0xff)) & 0xff;
    previous = bytes[index];
  }
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    encoded += BASE64URL_ALPHABET[a >> 2];
    encoded += BASE64URL_ALPHABET[((a & 3) << 4) | (b >> 4)];
    if (index + 1 < bytes.length) encoded += BASE64URL_ALPHABET[((b & 15) << 2) | (c >> 6)];
    if (index + 2 < bytes.length) encoded += BASE64URL_ALPHABET[c & 63];
  }
  return `${encoded}${machineId}`;
}

function requestHeaders(config) {
  const headers = {
    ":method": "POST",
    ":path": config.path,
    authorization: `Bearer ${config.accessToken}`,
    "content-type": config.contentType,
    accept: config.contentType,
    "accept-encoding": "gzip",
    te: "trailers",
    "user-agent": "connect-es/1.6.1",
    "x-amzn-trace-id": randomUUID(),
    "x-client-key": sha256(config.accessToken),
    "x-cursor-checksum": cursorChecksum(config.machineId),
    "x-cursor-client-version": CLIENT_VERSION,
    "x-cursor-client-type": "ide",
    "x-cursor-client-os": process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
    "x-cursor-client-arch": process.arch,
    "x-cursor-client-device-type": "desktop",
    "x-cursor-config-version": randomUUID(),
    "x-cursor-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    "x-ghost-mode": "false",
    "x-new-onboarding-completed": "true",
    "x-session-id": uuidV5Dns(config.accessToken),
    "x-request-id": randomUUID(),
  };
  if (config.connectProtocolVersion) headers["connect-protocol-version"] = config.connectProtocolVersion;
  return headers;
}

function headerEntries(headers) {
  const entries = [];
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith(":") || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) entries.push([name, String(item)]);
    } else {
      entries.push([name, String(value)]);
    }
  }
  return entries;
}

function clearIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
}

function resetIdleTimer() {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    const idleClient = client;
    client = undefined;
    clientOrigin = undefined;
    if (idleClient && !idleClient.closed && !idleClient.destroyed) idleClient.close();
  }, IDLE_CONNECTION_TIMEOUT_MS);
  idleTimer.unref();
}

function getClient(origin) {
  if (client && clientOrigin === origin && !client.closed && !client.destroyed) return client;
  if (client && !client.destroyed) client.destroy();
  const session = http2.connect(origin);
  client = session;
  clientOrigin = origin;
  session.on("error", () => {
    if (!session.destroyed) session.destroy();
    if (client === session) {
      client = undefined;
      clientOrigin = undefined;
    }
  });
  session.on("goaway", () => {
    if (client === session) {
      client = undefined;
      clientOrigin = undefined;
    }
    if (!session.closed && !session.destroyed) session.close();
  });
  session.on("close", () => {
    if (client === session) {
      client = undefined;
      clientOrigin = undefined;
    }
  });
  return session;
}

function syncFlow(request) {
  if (request !== active || request.stream.destroyed) return;
  if (request.parentPaused || request.stdoutPaused) request.stream.pause();
  else request.stream.resume();
}

function noteBackpressure(request, writable) {
  if (writable || request.stdoutPaused) return;
  request.stdoutPaused = true;
  request.stream.pause();
  process.stdout.once("drain", () => {
    if (request !== active) return;
    request.stdoutPaused = false;
    syncFlow(request);
  });
}

function sendMetadata(request, type, value) {
  const content = Buffer.from(JSON.stringify(value), "utf8");
  if (content.length > MAX_CONFIG_BYTES) throw new Error("Response metadata too large");
  noteBackpressure(request, writeForRequest(request, type, content));
}

function sendData(request, chunk) {
  for (let offset = 0; offset < chunk.length; offset += MAX_DATA_BYTES) {
    const content = chunk.subarray(offset, Math.min(offset + MAX_DATA_BYTES, chunk.length));
    noteBackpressure(request, writeForRequest(request, OUT_DATA, content));
  }
}

function finishActive(request) {
  if (request !== active || request.finished) return;
  request.finished = true;
  clearTimeout(request.timeoutTimer);
  if (request.forceTimer) clearTimeout(request.forceTimer);
  active = undefined;
  const resultType = request.outcome === "cancel"
    ? OUT_CANCELLED
    : request.outcome === "timeout"
      ? OUT_TIMEOUT
      : request.outcome === "done"
        ? OUT_DONE
        : OUT_ERROR;
  writeForRequest(request, resultType);
  resetIdleTimer();
}

function terminateActive(request, outcome) {
  if (request !== active || request.finished) return;
  if (request.outcome !== "cancel" && request.outcome !== "timeout") request.outcome = outcome;
  if (!request.stream.closed && !request.stream.destroyed) {
    request.stream.close(http2.constants.NGHTTP2_CANCEL);
  }
  request.forceTimer = setTimeout(() => {
    if (request !== active) return;
    if (!request.stream.destroyed) request.stream.destroy();
    setImmediate(() => finishActive(request));
  }, STREAM_CLEANUP_GRACE_MS);
}

function openRequest(config, body) {
  clearIdleTimer();
  let stream;
  try {
    stream = getClient(config.origin).request(requestHeaders(config));
  } catch {
    if (client && !client.destroyed) client.destroy();
    client = undefined;
    clientOrigin = undefined;
    try {
      stream = getClient(config.origin).request(requestHeaders(config));
    } catch {
      writeForRequest(config, OUT_ERROR);
      resetIdleTimer();
      return;
    }
  }

  const request = {
    id: config.id,
    stream,
    outcome: "error",
    responseSent: false,
    trailersSent: false,
    parentPaused: false,
    stdoutPaused: false,
    finished: false,
    timeoutTimer: undefined,
    forceTimer: undefined,
  };
  active = request;
  request.timeoutTimer = setTimeout(() => {
    request.outcome = "timeout";
    terminateActive(request, "timeout");
  }, config.timeoutMs);

  stream.on("response", (headers) => {
    if (request !== active || request.responseSent) return;
    const status = Number(headers[":status"]);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      terminateActive(request, "error");
      return;
    }
    try {
      sendMetadata(request, OUT_RESPONSE, { status, headers: headerEntries(headers) });
      request.responseSent = true;
    } catch {
      terminateActive(request, "error");
    }
  });
  stream.on("data", (chunk) => {
    if (request !== active || !request.responseSent) {
      terminateActive(request, "error");
      return;
    }
    sendData(request, Buffer.from(chunk));
  });
  stream.on("trailers", (headers) => {
    if (request !== active || !request.responseSent || request.trailersSent) {
      terminateActive(request, "error");
      return;
    }
    try {
      sendMetadata(request, OUT_TRAILERS, headerEntries(headers));
      request.trailersSent = true;
    } catch {
      terminateActive(request, "error");
    }
  });
  stream.on("end", () => {
    if (request === active && request.outcome !== "cancel" && request.outcome !== "timeout") {
      request.outcome = request.responseSent ? "done" : "error";
    }
  });
  stream.on("aborted", () => {
    if (request === active && request.outcome !== "cancel" && request.outcome !== "timeout") {
      request.outcome = "error";
    }
  });
  stream.on("error", () => {
    if (request === active && request.outcome !== "cancel" && request.outcome !== "timeout") {
      request.outcome = "error";
    }
  });
  stream.on("close", () => finishActive(request));
  stream.end(body);
}

function matchesActive(payload) {
  return payload.length === 16 && active && payload.equals(active.id);
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearIdleTimer();
  if (active && !active.stream.destroyed) active.stream.destroy();
  if (client && !client.destroyed) client.destroy();
  process.exit(0);
}

async function main() {
  while (!shuttingDown) {
    const message = await readTyped();
    if (!message) break;
    if (message.type === IN_REQUEST_CONFIG) {
      if (active || pendingConfig) throw new Error("IPC protocol error");
      pendingConfig = parseConfig(message.payload);
    } else if (message.type === IN_REQUEST_BODY) {
      if (active || !pendingConfig || message.payload.length !== pendingConfig.bodyLength) {
        throw new Error("IPC protocol error");
      }
      const config = pendingConfig;
      pendingConfig = undefined;
      openRequest(config, message.payload);
    } else if (message.type === IN_CANCEL) {
      if (matchesActive(message.payload)) {
        active.outcome = "cancel";
        terminateActive(active, "cancel");
      }
    } else if (message.type === IN_PAUSE) {
      if (matchesActive(message.payload)) {
        active.parentPaused = true;
        syncFlow(active);
      }
    } else if (message.type === IN_RESUME) {
      if (matchesActive(message.payload)) {
        active.parentPaused = false;
        syncFlow(active);
      }
    } else if (message.type === IN_SHUTDOWN) {
      shutdown();
    } else {
      throw new Error("IPC protocol error");
    }
  }
  shutdown();
}

main().catch(() => sendFatalAndExit());
