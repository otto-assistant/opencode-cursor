/**
 * Atomic read/write access to OpenCode's auth.json Cursor entry.
 * Single implementation used by plugin config, browser login, and token refresh.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { CURSOR_PROVIDER_ID } from "../shared/constants.js";
import { log } from "../shared/log.js";
import {
  isCursorOAuthCredential,
  type CursorOAuthCredential,
} from "./credential-manager.js";

function getOpencodeAuthPath(): string {
  const base =
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "opencode", "auth.json");
}

/**
 * Best-effort read of the stored Cursor OAuth entry.
 * Returns undefined if missing or malformed. Expired access tokens are still
 * returned when a refresh token is present so callers can refresh.
 */
export function readStoredCursorAuth(): CursorOAuthCredential | undefined {
  try {
    const data = JSON.parse(readFileSync(getOpencodeAuthPath(), "utf8"));
    const cursor = data?.[CURSOR_PROVIDER_ID];
    if (!isCursorOAuthCredential(cursor)) return undefined;
    if (!cursor.refresh) return undefined;
    return {
      type: "oauth",
      access: typeof cursor.access === "string" ? cursor.access : undefined,
      refresh: cursor.refresh,
      expires: cursor.expires,
    };
  } catch {
    return undefined;
  }
}

/**
 * Persist Cursor credentials into OpenCode's auth.json.
 * Uses temp-file + rename for atomicity and preserves other provider entries.
 */
export function writeStoredCursorAuth(auth: CursorOAuthCredential): void {
  try {
    const authPath = getOpencodeAuthPath();
    mkdirSync(dirname(authPath), { recursive: true });

    let data: Record<string, unknown> = {};
    if (existsSync(authPath)) {
      try {
        data = JSON.parse(readFileSync(authPath, "utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        // Keep empty object only when the file is unreadable JSON.
        data = {};
      }
    }

    data[CURSOR_PROVIDER_ID] = {
      type: "oauth",
      access: auth.access,
      refresh: auth.refresh,
      expires: auth.expires,
    };

    const tmpPath = `${authPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    renameSync(tmpPath, authPath);
  } catch (err) {
    const summary = err instanceof Error ? err.message : String(err);
    log.warn(
      `[opencode-cursor] failed to persist refreshed Cursor auth: ${summary}`,
    );
  }
}
