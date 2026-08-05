import { Buffer } from "node:buffer";
import { afterEach, describe, expect, test } from "bun:test";
import {
  generateCursorAuthParams,
  getTokenExpiry,
  tryPollCursorAuth,
} from "../src/auth";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Cursor OAuth", () => {
  test("generates a valid PKCE browser login URL", async () => {
    const params = await generateCursorAuthParams();
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(params.verifier),
    );

    expect(params.challenge).toBe(Buffer.from(digest).toString("base64url"));
    expect(params.uuid).not.toBeEmpty();
    const loginUrl = new URL(params.loginUrl);
    expect(loginUrl.origin + loginUrl.pathname).toBe(
      "https://cursor.com/loginDeepControl",
    );
    expect(loginUrl.searchParams.get("uuid")).toBe(params.uuid);
    expect(loginUrl.searchParams.get("challenge")).toBe(params.challenge);
    expect(loginUrl.searchParams.get("mode")).toBe("login");
    expect(loginUrl.searchParams.get("redirectTarget")).toBe("cli");
  });

  test("polls immediately and distinguishes pending, success, and failure", async () => {
    const responses = [
      new Response("", { status: 404 }),
      Response.json({ accessToken: "access", refreshToken: "refresh" }),
      new Response("private response", { status: 401 }),
    ];
    globalThis.fetch = (async () => responses.shift()!) as typeof fetch;

    await expect(tryPollCursorAuth("uuid", "verifier")).resolves.toBeNull();
    await expect(tryPollCursorAuth("uuid", "verifier")).resolves.toEqual({
      accessToken: "access",
      refreshToken: "refresh",
    });
    await expect(tryPollCursorAuth("uuid", "verifier")).rejects.toThrow(
      "Poll failed: 401",
    );
  });

  test("rejects malformed successful poll responses", async () => {
    const responses = [
      Response.json({}),
      Response.json({ accessToken: "", refreshToken: "refresh" }),
      Response.json({ accessToken: 123, refreshToken: "refresh" }),
      Response.json({ accessToken: "access", refreshToken: null }),
    ];
    globalThis.fetch = (async () => responses.shift()!) as typeof fetch;

    for (let index = 0; index < 4; index++) {
      await expect(tryPollCursorAuth("uuid", "verifier")).rejects.toThrow(
        "Cursor auth poll returned an invalid response",
      );
    }
  });

  test("uses JWT expiry with a safety margin and bounds opaque-token fallback", () => {
    const futureExp = Math.floor(Date.now() / 1_000) + 7_200;
    const payload = Buffer.from(JSON.stringify({ exp: futureExp })).toString(
      "base64url",
    );
    const before = Date.now();

    expect(getTokenExpiry(`header.${payload}.signature`)).toBe(
      futureExp * 1_000 - 5 * 60 * 1_000,
    );
    const fallback = getTokenExpiry("not-a-jwt");
    expect(fallback).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(fallback).toBeLessThanOrEqual(Date.now() + 3_600_000);
  });
});
