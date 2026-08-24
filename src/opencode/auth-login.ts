/** Cursor browser OAuth polling used by the OpenCode V2 integration. */
import {
  generateCursorAuthParams,
  getTokenExpiry,
  tryPollCursorAuth,
} from "../auth.js";
import { clearModelCache } from "../models.js";
import { log } from "../shared/log.js";

export type PendingCursorLogin = {
  url: string;
  uuid: string;
  verifier: string;
  startedAt: number;
  completed: boolean;
  result: Promise<CursorBrowserLoginResult>;
};

export type CursorBrowserLoginResult = {
  access: string;
  refresh: string;
  expires: number;
};

type CursorLoginSession = PendingCursorLogin & {
  timer: ReturnType<typeof setTimeout> | undefined;
  resolve: (value: CursorBrowserLoginResult) => void;
  reject: (reason: Error) => void;
};

const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_MS = 15 * 60 * 1_000;

let current: CursorLoginSession | undefined;
let startInFlight: Promise<CursorLoginSession> | undefined;
let generation = 0;

function clearTimer(session: CursorLoginSession): void {
  if (!session.timer) return;
  clearTimeout(session.timer);
  session.timer = undefined;
}

function failSession(
  session: CursorLoginSession,
  error: Error,
): void {
  if (current !== session || session.completed) return;
  clearTimer(session);
  session.completed = true;
  session.reject(error);
}

function completeSession(
  session: CursorLoginSession,
  result: CursorBrowserLoginResult,
): void {
  if (current !== session || session.completed) return;
  clearTimer(session);
  session.completed = true;
  session.resolve(result);
}

function schedulePoll(
  session: CursorLoginSession,
  delayMs: number,
): void {
  clearTimer(session);
  if (current !== session || session.completed) return;
  session.timer = setTimeout(() => {
    void runPollTick(session);
  }, delayMs);
}

async function runPollTick(session: CursorLoginSession): Promise<void> {
  if (current !== session || session.completed) return;

  if (Date.now() - session.startedAt > POLL_MAX_MS) {
    const error = new Error("Cursor authentication polling timeout");
    log.error(`[opencode-cursor] Browser login failed: ${error.message}`);
    failSession(session, error);
    return;
  }

  try {
    const tokens = await tryPollCursorAuth(
      session.uuid,
      session.verifier,
    );
    if (!tokens) {
      schedulePoll(session, POLL_INTERVAL_MS);
      return;
    }

    clearModelCache();
    log.info("[opencode-cursor] Browser login complete");
    completeSession(session, {
      access: tokens.accessToken,
      refresh: tokens.refreshToken,
      expires: getTokenExpiry(tokens.accessToken),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    if (/fetch|network|timeout|ECONN|ENOTFOUND|429|5\d\d/i.test(message)) {
      schedulePoll(session, POLL_INTERVAL_MS + 1_000);
      return;
    }
    log.error(`[opencode-cursor] Browser login failed: ${message}`);
    failSession(
      session,
      error instanceof Error ? error : new Error(message),
    );
  }
}

export async function startCursorBrowserLogin(): Promise<PendingCursorLogin> {
  if (
    current &&
    !current.completed &&
    Date.now() - current.startedAt < POLL_MAX_MS
  ) {
    return current;
  }
  if (startInFlight) return startInFlight;

  resetPendingCursorLogin();
  const expectedGeneration = generation;
  const attempt = (async () => {
    const { verifier, uuid, loginUrl } =
      await generateCursorAuthParams();
    if (expectedGeneration !== generation) {
      throw new Error("Cursor browser login cancelled");
    }
    let resolve!: (value: CursorBrowserLoginResult) => void;
    let reject!: (reason: Error) => void;
    const result = new Promise<CursorBrowserLoginResult>(
      (resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      },
    );
    const session: CursorLoginSession = {
      url: loginUrl,
      uuid,
      verifier,
      startedAt: Date.now(),
      completed: false,
      timer: undefined,
      result,
      resolve,
      reject,
    };
    result.catch(() => {});
    current = session;
    log.info(`[opencode-cursor] Cursor login URL: ${loginUrl}`);
    schedulePoll(session, 500);
    return session;
  })();
  startInFlight = attempt;
  try {
    return await attempt;
  } finally {
    if (startInFlight === attempt) startInFlight = undefined;
  }
}

export function getPendingCursorLogin(): PendingCursorLogin | null {
  return current ?? null;
}

export function resetPendingCursorLogin(): void {
  generation += 1;
  startInFlight = undefined;
  const session = current;
  current = undefined;
  if (!session) return;
  clearTimer(session);
  if (session.completed) return;
  session.completed = true;
  session.reject(new Error("Cursor browser login cancelled"));
}
