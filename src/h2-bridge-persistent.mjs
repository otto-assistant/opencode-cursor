#!/usr/bin/env node
/**
 * Persistent HTTP/2 bridge for Cursor gRPC.
 *
 * Unlike h2-bridge.mjs (one-shot per process), this process stays alive
 * across multiple requests, reusing the HTTP/2 connection to Cursor.
 * Saves ~300-500ms per request (Node.js startup + TLS/H2 handshake).
 *
 * Typed length-prefixed framing:
 *   [4B big-endian total_len][1B type][payload of total_len-1 bytes]
 *
 * Parent → Bridge:
 *   0x00 NEW_REQUEST  config JSON → open new H2 stream
 *   0x01 WRITE        raw bytes → write to current H2 stream
 *   0x02 END_WRITES   end writes on current H2 stream
 *   0x03 SHUTDOWN     graceful exit
 *
 * Bridge → Parent:
 *   0x00 DATA         H2 response chunk
 *   0x01 STREAM_DONE  stream completed (1B: 0=success, 1=error)
 *   0x02 ERROR        fatal error, bridge will exit (payload: message)
 */
import http2 from "node:http2";
import crypto from "node:crypto";

const CURSOR_CLIENT_VERSION = "cli-2026.01.09-231024f";

// --- Message types ---
const IN_NEW_REQUEST = 0x00;
const IN_WRITE = 0x01;
const IN_END_WRITES = 0x02;
const IN_SHUTDOWN = 0x03;

const OUT_DATA = 0x00;
const OUT_STREAM_DONE = 0x01;
const OUT_ERROR = 0x02;

// --- Typed framing ---

/** Write one typed message to stdout: [4B len][1B type][payload]. */
function writeTyped(type, payload) {
  const totalLen = 1 + payload.length;
  const buf = Buffer.alloc(4 + totalLen);
  buf.writeUInt32BE(totalLen, 0);
  buf[4] = type;
  if (payload.length > 0) payload.copy ? payload.copy(buf, 5) : buf.set(payload, 5);
  process.stdout.write(buf);
}

function sendData(chunk) {
  writeTyped(OUT_DATA, chunk);
}

function sendStreamDone(success) {
  writeTyped(OUT_STREAM_DONE, Buffer.from([success ? 0 : 1]));
}

function sendError(message) {
  writeTyped(OUT_ERROR, Buffer.from(message, "utf8"));
}

// --- Buffered stdin reader ---

let stdinBuf = Buffer.alloc(0);
let stdinResolve = null;
let stdinEnded = false;

process.stdin.on("data", (chunk) => {
  stdinBuf = Buffer.concat([stdinBuf, chunk]);
  if (stdinResolve) {
    const r = stdinResolve;
    stdinResolve = null;
    r();
  }
});

process.stdin.on("end", () => {
  stdinEnded = true;
  if (stdinResolve) {
    const r = stdinResolve;
    stdinResolve = null;
    r();
  }
});

function waitForData() {
  return new Promise((resolve) => {
    stdinResolve = resolve;
  });
}

async function readExact(n) {
  while (stdinBuf.length < n) {
    if (stdinEnded) return null;
    await waitForData();
  }
  const result = stdinBuf.subarray(0, n);
  stdinBuf = stdinBuf.subarray(n);
  return Buffer.from(result);
}

/** Read one typed message: returns {type, payload} or null on EOF. */
async function readTypedMessage() {
  const lenBuf = await readExact(4);
  if (!lenBuf) return null;
  const totalLen = lenBuf.readUInt32BE(0);
  if (totalLen === 0) return null;
  const body = await readExact(totalLen);
  if (!body) return null;
  return { type: body[0], payload: body.subarray(1) };
}

// --- H2 connection management ---

let h2Client = null;
let currentUrl = null;
let h2Stream = null;
let streamDone = false;
let streamTimeout = null;
let idleTimeout = null;

const STREAM_TIMEOUT_MS = 120_000;
const IDLE_CONNECTION_TIMEOUT_MS = 5 * 60 * 1000;

function resetStreamTimeout() {
  if (streamTimeout) clearTimeout(streamTimeout);
  streamTimeout = setTimeout(() => {
    if (h2Stream && !h2Stream.closed && !h2Stream.destroyed) {
      h2Stream.destroy();
    }
  }, STREAM_TIMEOUT_MS);
}

function clearStreamTimeout() {
  if (streamTimeout) {
    clearTimeout(streamTimeout);
    streamTimeout = null;
  }
}

function resetIdleTimeout() {
  if (idleTimeout) clearTimeout(idleTimeout);
  idleTimeout = setTimeout(() => {
    if (h2Client && !h2Client.closed && !h2Client.destroyed) {
      h2Client.close();
    }
    h2Client = null;
    currentUrl = null;
  }, IDLE_CONNECTION_TIMEOUT_MS);
}

function clearIdleTimeout() {
  if (idleTimeout) {
    clearTimeout(idleTimeout);
    idleTimeout = null;
  }
}

function getOrCreateClient(url) {
  if (h2Client && !h2Client.closed && !h2Client.destroyed && url === currentUrl) {
    return h2Client;
  }
  if (h2Client) {
    try {
      h2Client.destroy();
    } catch {}
  }
  // Capture the new session in a local so event handlers only affect
  // their own session — stale handlers from a previous session must not
  // be able to corrupt a newer one (causes "Connection reset by server").
  const session = http2.connect(url);
  h2Client = session;
  currentUrl = url;

  session.on("error", () => {
    try { session.destroy(); } catch {}
    if (h2Client === session) {
      h2Client = null;
      currentUrl = null;
    }
  });
  session.on("goaway", () => {
    try { session.destroy(); } catch {}
    if (h2Client === session) {
      h2Client = null;
      currentUrl = null;
    }
  });
  session.on("close", () => {
    if (h2Client === session) {
      h2Client = null;
      currentUrl = null;
    }
  });

  return session;
}

function handleStreamComplete(success) {
  if (streamDone) return;
  streamDone = true;
  clearStreamTimeout();
  h2Stream = null;
  resetIdleTimeout();
  sendStreamDone(success);
}

function openStream(config) {
  const { accessToken, url, path: rpcPath, unary } = config;
  const apiUrl = url || "https://api2.cursor.sh";
  streamDone = false;
  clearIdleTimeout();

  let client;
  try {
    client = getOrCreateClient(apiUrl);
  } catch (e) {
    sendError(`Failed to connect: ${e.message}`);
    handleStreamComplete(false);
    return;
  }

  const headers = {
    ":method": "POST",
    ":path": rpcPath || "/agent.v1.AgentService/Run",
    "content-type": unary ? "application/proto" : "application/connect+proto",
    te: "trailers",
    authorization: `Bearer ${accessToken}`,
    "x-ghost-mode": "true",
    "x-cursor-client-version": CURSOR_CLIENT_VERSION,
    "x-cursor-client-type": "cli",
    "x-request-id": crypto.randomUUID(),
  };
  if (!unary) {
    headers["connect-protocol-version"] = "1";
  }

  try {
    h2Stream = client.request(headers);
  } catch (_e) {
    // Connection may have died — try reconnecting once
    h2Client = null;
    currentUrl = null;
    try {
      const newClient = getOrCreateClient(apiUrl);
      h2Stream = newClient.request(headers);
    } catch (e2) {
      handleStreamComplete(false);
      return;
    }
  }

  resetStreamTimeout();

  h2Stream.on("data", (chunk) => {
    resetStreamTimeout();
    sendData(chunk);
  });

  h2Stream.on("end", () => handleStreamComplete(true));
  h2Stream.on("error", () => handleStreamComplete(false));

  // For unary requests, we expect the caller to send WRITE then END_WRITES.
  // The stream will complete via the "end" event.
}

// --- Main message loop ---

async function main() {
  while (true) {
    const msg = await readTypedMessage();
    if (!msg) break; // stdin closed

    switch (msg.type) {
      case IN_NEW_REQUEST: {
        const config = JSON.parse(msg.payload.toString("utf8"));
        openStream(config);
        break;
      }
      case IN_WRITE: {
        if (h2Stream && !h2Stream.closed && !h2Stream.destroyed) {
          resetStreamTimeout();
          h2Stream.write(msg.payload);
        }
        break;
      }
      case IN_END_WRITES: {
        if (h2Stream && !h2Stream.closed && !h2Stream.destroyed) {
          h2Stream.end();
        }
        break;
      }
      case IN_SHUTDOWN: {
        clearStreamTimeout();
        clearIdleTimeout();
        if (h2Stream && !h2Stream.closed && !h2Stream.destroyed) {
          h2Stream.destroy();
        }
        if (h2Client && !h2Client.closed && !h2Client.destroyed) {
          h2Client.close();
        }
        process.exit(0);
        break;
      }
    }
  }

  // stdin closed — clean up and exit
  clearStreamTimeout();
  clearIdleTimeout();
  if (h2Stream && !h2Stream.closed && !h2Stream.destroyed) {
    h2Stream.destroy();
  }
  if (h2Client && !h2Client.closed && !h2Client.destroyed) {
    h2Client.close();
  }
  process.exit(0);
}

main().catch((e) => {
  sendError(`Bridge fatal: ${e.message}`);
  process.exit(1);
});
