const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
const CURSOR_REFRESH_URL =
  process.env.CURSOR_REFRESH_URL ??
  "https://api2.cursor.sh/auth/exchange_user_api_key";

/** Per-request network timeout for a single poll attempt. */
const POLL_REQUEST_TIMEOUT_MS = 30_000;
/** Network timeout for the token refresh exchange. */
const REFRESH_REQUEST_TIMEOUT_MS = 30_000;

export async function generatePKCE(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifierBytes = new Uint8Array(96);
  crypto.getRandomValues(verifierBytes);
  const verifier = Buffer.from(verifierBytes).toString("base64url");
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return {
    verifier,
    challenge: Buffer.from(hashBuffer).toString("base64url"),
  };
}

export interface CursorAuthParams {
  verifier: string;
  challenge: string;
  uuid: string;
  loginUrl: string;
}

export interface CursorCredentials {
  access: string;
  refresh: string;
  expires: number;
}

export async function generateCursorAuthParams(): Promise<CursorAuthParams> {
  const { verifier, challenge } = await generatePKCE();
  const uuid = crypto.randomUUID();

  const params = new URLSearchParams({
    challenge,
    uuid,
    mode: "login",
    redirectTarget: "cli",
  });

  const loginUrl = `${CURSOR_LOGIN_URL}?${params.toString()}`;
  return { verifier, challenge, uuid, loginUrl };
}

/** Single Cursor auth poll attempt. Returns null while the user has not approved yet (HTTP 404). */
export async function tryPollCursorAuth(
  uuid: string,
  verifier: string,
): Promise<{ accessToken: string; refreshToken: string } | null> {
  const response = await fetch(
    `${CURSOR_POLL_URL}?uuid=${uuid}&verifier=${verifier}`,
    { signal: AbortSignal.timeout(POLL_REQUEST_TIMEOUT_MS) },
  );

  if (response.status === 404) {
    return null;
  }

  if (response.ok) {
    const data = (await response.json()) as {
      accessToken: string;
      refreshToken: string;
    };
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
    };
  }

  throw new Error(`Poll failed: ${response.status}`);
}

/**
 * RefreshTokenInvalidError — Cursor refused the refresh token (4xx).
 * The stored credential is unusable; re-login is required.
 */
export class RefreshTokenInvalidError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(
      `Cursor token refresh rejected (HTTP ${status}): ${body || "<empty body>"}`,
    );
    this.name = "RefreshTokenInvalidError";
    this.status = status;
    this.body = body;
  }
}

function looksLikeJwt(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

export async function refreshCursorToken(
  refreshToken: string,
): Promise<CursorCredentials> {
  const response = await fetch(CURSOR_REFRESH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${refreshToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(REFRESH_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const isPermanent =
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408 &&
      response.status !== 429;
    if (isPermanent) {
      throw new RefreshTokenInvalidError(response.status, body);
    }
    throw new Error(
      `Cursor token refresh failed (HTTP ${response.status}): ${body || "<empty body>"}`,
    );
  }

  const data = (await response.json()) as {
    accessToken: string;
    refreshToken?: string;
  };

  // Only adopt `data.refreshToken` when it actually looks like a JWT —
  // Cursor sometimes echoes a non-JWT API key that would clobber the OAuth refresh.
  const nextRefresh = looksLikeJwt(data.refreshToken)
    ? data.refreshToken
    : refreshToken;

  return {
    access: data.accessToken,
    refresh: nextRefresh,
    expires: getTokenExpiry(data.accessToken),
  };
}

/**
 * Extract JWT expiry with 5-minute safety margin.
 * Falls back to 1 hour from now if token can't be parsed.
 */
export function getTokenExpiry(token: string): number {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) {
      return Date.now() + 3600 * 1000;
    }
    const decoded = JSON.parse(
      atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
    if (
      decoded &&
      typeof decoded === "object" &&
      typeof decoded.exp === "number"
    ) {
      return decoded.exp * 1000 - 5 * 60 * 1000;
    }
  } catch {
  }
  return Date.now() + 3600 * 1000;
}
