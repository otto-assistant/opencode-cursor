import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { getTokenExpiry, refreshCursorToken } from "../../src/auth";

function makeJwt(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.sig`;
}

function expectFallbackHour(value: number, startedAt: number): void {
  const min = startedAt + 60 * 60 * 1000 - 2_000;
  const max = Date.now() + 60 * 60 * 1000 + 2_000;
  expect(value).toBeGreaterThanOrEqual(min);
  expect(value).toBeLessThanOrEqual(max);
}

describe("getTokenExpiry", () => {
  test("extracts exp with 5-minute safety margin", () => {
    const exp = Math.floor(Date.now() / 1000) + 4_000;
    const token = makeJwt({ exp });
    expect(getTokenExpiry(token)).toBe(exp * 1000 - 5 * 60 * 1000);
  });

  test("falls back when JWT has wrong parts count", () => {
    const started = Date.now();
    expectFallbackHour(getTokenExpiry("only.two"), started);
  });

  test("falls back when payload is empty", () => {
    const started = Date.now();
    expectFallbackHour(getTokenExpiry("header..sig"), started);
  });

  test("falls back when payload base64 is malformed", () => {
    const started = Date.now();
    expectFallbackHour(getTokenExpiry("header.%$#@.sig"), started);
  });

  test("falls back when exp field is missing", () => {
    const started = Date.now();
    const token = makeJwt({ sub: "u1" });
    expectFallbackHour(getTokenExpiry(token), started);
  });
});

describe("refreshCursorToken", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("returns normalized credentials on success", async () => {
    const exp = Math.floor(Date.now() / 1000) + 7_200;
    const accessToken = makeJwt({ exp });
    const refreshToken = "new-refresh";

    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      expect(url).toContain("exchange_user_api_key");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer refresh-123");
      return new Response(
        JSON.stringify({ accessToken, refreshToken }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await refreshCursorToken("refresh-123");
    expect(result.access).toBe(accessToken);
    expect(result.refresh).toBe(refreshToken);
    expect(result.expires).toBe(exp * 1000 - 5 * 60 * 1000);
  });

  test("throws on non-OK status and does not leak provided refresh token", async () => {
    const providedToken = "super-secret-refresh-token";
    globalThis.fetch = mock(async () =>
      new Response("upstream unauthorized", { status: 401 })) as typeof fetch;

    await expect(refreshCursorToken(providedToken)).rejects.toThrow(
      "Cursor token refresh failed: upstream unauthorized",
    );

    try {
      await refreshCursorToken(providedToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message.includes(providedToken)).toBe(false);
    }
  });

  test("surfaces timeout-like fetch failures", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("Request timed out");
    }) as typeof fetch;

    await expect(refreshCursorToken("refresh-token")).rejects.toThrow(
      "Request timed out",
    );
  });
});
