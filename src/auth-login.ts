/**
 * Headless Cursor browser OAuth for hosts (e.g. OpenChamber) that do not
 * surface plugin `auth.methods` on the provider detail page.
 *
 * Starts the same PKCE login as `opencode auth login`, logs the browser URL,
 * polls in the background, and writes tokens to OpenCode's auth.json.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  generateCursorAuthParams,
  getTokenExpiry,
  tryPollCursorAuth,
} from "./auth.js";
import { clearModelCache } from "./models.js";
import { log } from "./log.js";

export type PendingCursorLogin = {
  url: string;
  uuid: string;
  /** PKCE verifier — needed if the official OAuth callback shares this session. */
  verifier: string;
  startedAt: number;
  polling: boolean;
  completed: boolean;
  error?: string;
};

export type CursorBrowserLoginResult = {
  access: string;
  refresh: string;
  expires: number;
};

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_MS = 15 * 60 * 1000;

let pending: PendingCursorLogin | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollResolve: ((value: CursorBrowserLoginResult) => void) | null = null;
let pollReject: ((reason?: unknown) => void) | null = null;
let pollInFlight: Promise<CursorBrowserLoginResult> | null = null;

function authJsonPath(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ? xdg : join(homedir(), ".local", "share");
  return join(base, "opencode", "auth.json");
}

function writeCursorAuth(accessToken: string, refreshToken: string): number {
  const path = authJsonPath();
  mkdirSync(dirname(path), { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      existing = {};
    }
  }

  const expires = getTokenExpiry(accessToken);
  existing.cursor = {
    type: "oauth",
    refresh: refreshToken,
    access: accessToken,
    expires,
  };

  writeFileSync(path, JSON.stringify(existing, null, 2) + "\n", "utf8");
  return expires;
}

function clearPollTimer(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function failPending(error: Error): void {
  clearPollTimer();
  if (pending) {
    pending.error = error.message;
    pending.polling = false;
  }
  pollReject?.(error);
  pollResolve = null;
  pollReject = null;
}

function completePending(result: CursorBrowserLoginResult): void {
  clearPollTimer();
  if (pending) {
    pending.completed = true;
    pending.polling = false;
  }
  pollResolve?.(result);
  pollResolve = null;
  pollReject = null;
}

function schedulePoll(delayMs: number): void {
  clearPollTimer();
  if (!pending || pending.completed) return;
  pending.polling = true;
  pollTimer = setTimeout(() => {
    void runPollTick();
  }, delayMs);
}

async function runPollTick(): Promise<void> {
  if (!pending || pending.completed) return;

  if (Date.now() - pending.startedAt > POLL_MAX_MS) {
    const error = new Error("Cursor authentication polling timeout");
    log.error(`[opencode-cursor] Browser login failed: ${error.message}`);
    failPending(error);
    return;
  }

  try {
    const tokens = await tryPollCursorAuth(pending.uuid, pending.verifier);
    if (!tokens) {
      schedulePoll(POLL_INTERVAL_MS);
      return;
    }

    const expires = writeCursorAuth(tokens.accessToken, tokens.refreshToken);
    clearModelCache();
    log.info(
      "[opencode-cursor] Browser login complete — reload OpenChamber / OpenCode to load Cursor models",
    );
    completePending({
      access: tokens.accessToken,
      refresh: tokens.refreshToken,
      expires,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Transient network errors: keep trying.
    if (/fetch|network|timeout|ECONN|ENOTFOUND|429|5\d\d/i.test(message)) {
      schedulePoll(POLL_INTERVAL_MS + 1000);
      return;
    }
    log.error(`[opencode-cursor] Browser login failed: ${message}`);
    failPending(error instanceof Error ? error : new Error(message));
  }
}

/**
 * Start (or return) a Cursor browser OAuth login and begin background polling.
 * Safe to call repeatedly from the config hook while logged out.
 */
export async function startCursorBrowserLogin(): Promise<PendingCursorLogin> {
  if (
    pending &&
    !pending.completed &&
    Date.now() - pending.startedAt < POLL_MAX_MS
  ) {
    return pending;
  }

  resetPendingCursorLogin();

  const { verifier, uuid, loginUrl } = await generateCursorAuthParams();

  pending = {
    url: loginUrl,
    uuid,
    verifier,
    startedAt: Date.now(),
    polling: false,
    completed: false,
  };

  pollInFlight = new Promise<CursorBrowserLoginResult>((resolve, reject) => {
    pollResolve = resolve;
    pollReject = reject;
  });
  // Prevent unhandled rejection when only the config hook starts login.
  void pollInFlight.catch(() => {});

  console.log(
    "\n[opencode-cursor] Open this URL in your browser to authorize Cursor:\n",
  );
  console.log(`  ${loginUrl}\n`);
  console.log("[opencode-cursor] Waiting for authorization…\n");
  log.info(`[opencode-cursor] Cursor login URL: ${loginUrl}`);

  schedulePoll(500);
  return pending;
}

/** Await the in-flight browser login poll (shared with authorize callback). */
export async function waitForCursorBrowserLogin(): Promise<CursorBrowserLoginResult> {
  if (!pollInFlight) {
    await startCursorBrowserLogin();
  }
  if (!pollInFlight) {
    throw new Error("Cursor browser login is not in progress");
  }
  return pollInFlight;
}

export function getPendingCursorLogin(): PendingCursorLogin | null {
  return pending;
}

export function resetPendingCursorLogin(): void {
  clearPollTimer();
  if (pollReject) {
    pollReject(new Error("Cursor browser login cancelled"));
  }
  pending = null;
  pollInFlight = null;
  pollResolve = null;
  pollReject = null;
}
