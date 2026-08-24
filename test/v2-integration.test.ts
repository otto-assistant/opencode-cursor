import { describe, expect, test } from "bun:test";
import {
  CURSOR_INTEGRATION_ID,
  CURSOR_OAUTH_METHOD_ID,
  registerCursorIntegration,
} from "../src/opencode/integration";
import { resetPendingCursorLogin } from "../src/opencode/auth-login";
import { makeJwt } from "./helpers/jwt";

describe("OpenCode V2 Cursor integration", () => {
  test("registers one browser OAuth method with refresh support", async () => {
    let integrationName = "";
    let registration: Record<string, any> | undefined;
    const context = {
      integration: {
        transform: async (transform: (draft: any) => void) => {
          transform({
            update(id: string, update: (value: { name: string }) => void) {
              expect(id).toBe(CURSOR_INTEGRATION_ID);
              const value = { name: "" };
              update(value);
              integrationName = value.name;
            },
            method: {
              update(value: Record<string, any>) {
                registration = value;
              },
            },
          });
          return { dispose: async () => {} };
        },
      },
    };

    await registerCursorIntegration(context as never);

    expect(integrationName).toBe("Cursor");
    expect(registration?.integrationID).toBe(CURSOR_INTEGRATION_ID);
    expect(registration?.method).toEqual({
      id: CURSOR_OAUTH_METHOD_ID,
      type: "oauth",
      label: "Sign in with Cursor",
    });
    expect(typeof registration?.authorize).toBe("function");
    expect(typeof registration?.refresh).toBe("function");
  });

  test("refreshes through V2 credentials without replacing a JWT with an API key", async () => {
    let registration: Record<string, any> | undefined;
    const context = {
      integration: {
        transform: async (transform: (draft: any) => void) => {
          transform({
            update() {},
            method: {
              update(value: Record<string, any>) {
                registration = value;
              },
            },
          });
          return { dispose: async () => {} };
        },
      },
    };
    await registerCursorIntegration(context as never);

    const originalFetch = globalThis.fetch;
    const access = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    globalThis.fetch = (async () =>
      Response.json({
        accessToken: access,
        refreshToken: "key_short_lived",
      })) as typeof fetch;
    try {
      const refreshed = await registration?.refresh({
        type: "oauth",
        methodID: CURSOR_OAUTH_METHOD_ID,
        access: "expired",
        refresh: "original.refresh.jwt",
        expires: 0,
      });
      expect(refreshed.access).toBe(access);
      expect(refreshed.refresh).toBe("original.refresh.jwt");
      expect(refreshed.methodID).toBe(CURSOR_OAUTH_METHOD_ID);
      expect(refreshed.expires).toBeGreaterThan(Date.now());
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("starts a fresh OAuth session after a completed login", async () => {
    let registration: Record<string, any> | undefined;
    const context = {
      integration: {
        transform: async (transform: (draft: any) => void) => {
          transform({
            update() {},
            method: {
              update(value: Record<string, any>) {
                registration = value;
              },
            },
          });
          return { dispose: async () => {} };
        },
      },
    };
    await registerCursorIntegration(context as never);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        accessToken: makeJwt(
          Math.floor(Date.now() / 1000) + 3600,
        ),
        refreshToken: "refresh.jwt.token",
      })) as typeof fetch;
    try {
      const [first, simultaneous] = await Promise.all([
        registration?.authorize({}),
        registration?.authorize({}),
      ]);
      expect(simultaneous.url).toBe(first.url);
      await Promise.all([first.callback, simultaneous.callback]);
      const second = await registration?.authorize({});
      const cancelled = second.callback.catch(() => undefined);
      expect(second.url).not.toBe(first.url);
      resetPendingCursorLogin();
      await cancelled;
    } finally {
      resetPendingCursorLogin();
      globalThis.fetch = originalFetch;
    }
  });
});
