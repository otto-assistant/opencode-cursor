import { Buffer } from "node:buffer";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import http2, {
  type IncomingHttpHeaders,
  type ServerHttp2Session,
  type ServerHttp2Stream,
} from "node:http2";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";

type AuthModule = typeof import("../src/auth");
type AuthLoginModule = typeof import("../src/auth-login");
type IndexModule = typeof import("../src/index");
type ModelsModule = typeof import("../src/models");
type SelectionModule = typeof import("../src/model-selection");

const AVAILABLE_MODELS_PATH = "/aiserver.v1.AiService/AvailableModels";
const LOGICAL_BASE_URL = "https://cursor.invalid/v1";

const availableCatalog = [
  {
    name: "claude-fixture",
    clientDisplayName: "Claude Fixture",
    serverModelName: "claude-server-fixture",
    supportsThinking: true,
    supportsMaxMode: true,
    supportsNonMaxMode: true,
    parameterDefinitions: [
      {
        id: "reasoning",
        parameterType: {
          enumParameter: {
            values: [
              { value: "medium", displayName: "Medium" },
              { value: "high", displayName: "High" },
              { value: "max", displayName: "Max" },
            ],
          },
        },
      },
    ],
    variants: [
      {
        legacySlug: "claude-fixture-max",
        parameterValues: [{ id: "reasoning", value: "max" }],
        isDefaultMaxConfig: true,
        isMaxMode: true,
      },
      {
        legacySlug: "claude-fixture-medium",
        parameterValues: [{ id: "reasoning", value: "medium" }],
        isMaxMode: false,
      },
      {
        legacySlug: "claude-fixture-high",
        parameterValues: [{ id: "reasoning", value: "high" }],
        isMaxMode: false,
      },
    ],
  },
  { name: "gpt-fixture", clientDisplayName: "GPT Fixture", variants: [] },
  { name: "gemini-fixture", clientDisplayName: "Gemini Fixture", variants: [] },
  { name: "gemini-3-pro-image", clientDisplayName: "Gemini Image", variants: [] },
  { name: "default", clientDisplayName: "Cursor Default", variants: [] },
  { name: "composer-2", clientDisplayName: "Composer", variants: [] },
  { name: "grok-fixture", clientDisplayName: "Grok Fixture", variants: [] },
];

interface OAuthFixture {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
}

interface RefreshReply {
  status: number;
  body: Record<string, unknown> | string;
  delayMs?: number;
}

interface LocalServer {
  url: string;
  close(): Promise<void>;
}

let authSource: AuthModule;
let authLoginSource: AuthLoginModule;
let hooks: Hooks;
let indexSource: IndexModule;
let modelsSource: ModelsModule;
let selectionSource: SelectionModule;
let dataRoot = "";
let discoveryServer: LocalServer;
let refreshServer: LocalServer;
let sharedAuth: OAuthFixture;
let credentialWrites = 0;
let refreshRequestCount = 0;
let refreshReplies: RefreshReply[] = [];
let discoveryFailure = false;
const discoveryRequestCounts = new Map<string, number>();
const originalEnv = {
  api: process.env.CURSOR_API_URL,
  refresh: process.env.CURSOR_REFRESH_URL,
  xdg: process.env.XDG_DATA_HOME,
};
const originalConsoleLog = console.log;

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected an object");
  }
  return value as Record<string, unknown>;
}

function syntheticJwt(
  label: string,
  expiresAt = Math.floor(Date.now() / 1000) + 7_200,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: `synthetic-${label}`,
      exp: expiresAt,
    }),
  ).toString("base64url");
  return `${header}.${payload}.synthetic-signature`;
}

function bearerToken(headers: IncomingHttpHeaders): string {
  const raw = headers.authorization;
  const authorization = Array.isArray(raw) ? raw[0] : raw;
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
}

async function startDiscoveryServer(): Promise<LocalServer> {
  const sessions = new Set<ServerHttp2Session>();
  const server = http2.createServer();
  server.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });
  server.on(
    "stream",
    (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
      stream.on("error", () => {});
      stream.resume();
      if (headers[":path"] !== AVAILABLE_MODELS_PATH) {
        stream.respond({ ":status": 404, "content-type": "application/json" });
        stream.end("{}");
        return;
      }

      const token = bearerToken(headers);
      discoveryRequestCounts.set(
        token,
        (discoveryRequestCounts.get(token) ?? 0) + 1,
      );
      if (discoveryFailure || token === "failure-token") {
        stream.respond({ ":status": 503, "content-type": "application/json" });
        stream.end(JSON.stringify({ error: "synthetic failure" }));
        return;
      }
      stream.respond({ ":status": 200, "content-type": "application/json" });
      stream.end(JSON.stringify({ models: availableCatalog }));
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP/2 fixture did not bind");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const session of sessions) session.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function startRefreshServer(): Promise<LocalServer> {
  const sockets = new Set<Socket>();
  const server = http.createServer(async (request, response) => {
    refreshRequestCount += 1;
    for await (const _chunk of request) {
      // Drain the synthetic request body before responding.
    }
    const reply = refreshReplies.shift() ?? {
      status: 500,
      body: { error: "unexpected synthetic refresh" },
    };
    if (reply.delayMs) await Bun.sleep(reply.delayMs);
    response.writeHead(reply.status, {
      "content-type":
        typeof reply.body === "string" ? "text/plain" : "application/json",
      connection: "close",
    });
    response.end(
      typeof reply.body === "string"
        ? reply.body
        : JSON.stringify(reply.body),
    );
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Refresh fixture did not bind");
  }
  return {
    url: `http://127.0.0.1:${address.port}/refresh`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function authValue(): OAuthFixture {
  return { ...sharedAuth };
}

function fakeProvider(): { models: Record<string, unknown> } {
  return { models: {} };
}

function requireLoader(): NonNullable<NonNullable<Hooks["auth"]>["loader"]> {
  const loader = hooks.auth?.loader;
  if (!loader) throw new Error("Missing auth loader hook");
  return loader;
}

function requireProviderModels(): NonNullable<
  NonNullable<Hooks["provider"]>["models"]
> {
  const providerModels = hooks.provider?.models;
  if (!providerModels) throw new Error("Missing provider models hook");
  return providerModels;
}

function setDataHome(name: string): string {
  const home = join(dataRoot, name);
  process.env.XDG_DATA_HOME = home;
  return home;
}

async function writeStoredAuth(home: string, auth: OAuthFixture): Promise<void> {
  const directory = join(home, "opencode");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "auth.json"),
    `${JSON.stringify({ cursor: auth }, null, 2)}\n`,
  );
}

beforeAll(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "opencode-cursor-plugin-"));
  [discoveryServer, refreshServer] = await Promise.all([
    startDiscoveryServer(),
    startRefreshServer(),
  ]);
  process.env.XDG_DATA_HOME = dataRoot;
  process.env.CURSOR_API_URL = discoveryServer.url;
  process.env.CURSOR_REFRESH_URL = refreshServer.url;

  [authSource, authLoginSource, indexSource, modelsSource, selectionSource] =
    await Promise.all([
      import("../src/auth.ts"),
      import("../src/auth-login.ts"),
      import("../src/index.ts"),
      import("../src/models.ts"),
      import("../src/model-selection.ts"),
    ]);

  const input = {
    client: {
      auth: {
        async set(request: unknown) {
          const record = asRecord(request);
          if (record.throwOnError !== true) {
            throw new TypeError("Credential writes must enable throwOnError");
          }
          const body = asRecord(record.body);
          if (
            body.type !== "oauth" ||
            typeof body.access !== "string" ||
            typeof body.refresh !== "string" ||
            typeof body.expires !== "number"
          ) {
            throw new TypeError("Invalid synthetic credential write");
          }
          sharedAuth = {
            type: "oauth",
            access: body.access,
            refresh: body.refresh,
            expires: body.expires,
          };
          credentialWrites += 1;
          return { data: true };
        },
      },
    },
  } as unknown as PluginInput;
  hooks = await indexSource.CursorAuthPlugin(input);
});

beforeEach(() => {
  console.log = () => undefined;
  authLoginSource.resetPendingCursorLogin();
  modelsSource.clearModelCache();
  discoveryFailure = false;
  refreshReplies = [];
  sharedAuth = {
    type: "oauth",
    access: "initial-synthetic-access",
    refresh: syntheticJwt("initial-refresh"),
    expires: Date.now() + 60_000,
  };
});

afterEach(() => {
  console.log = originalConsoleLog;
});

afterAll(async () => {
  authLoginSource.resetPendingCursorLogin();
  try {
    await hooks.dispose?.();
    await Promise.all([discoveryServer.close(), refreshServer.close()]);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    restoreEnv("CURSOR_API_URL", originalEnv.api);
    restoreEnv("CURSOR_REFRESH_URL", originalEnv.refresh);
    restoreEnv("XDG_DATA_HOME", originalEnv.xdg);
  }
});

describe("Cursor browser login", () => {
  test("deduplicates concurrent PKCE starts", async () => {
    setDataHome("concurrent-login");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("", { status: 404 })) as typeof fetch;
    try {
      const starts = await Promise.all(
        Array.from({ length: 5 }, () =>
          authLoginSource.startCursorBrowserLogin(),
        ),
      );
      expect(new Set(starts.map((pending) => pending.uuid)).size).toBe(1);
      expect(new Set(starts.map((pending) => pending.url)).size).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      authLoginSource.resetPendingCursorLogin();
    }
  });

  test("restarts after a terminal polling failure", async () => {
    setDataHome("failed-login");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("", { status: 401 })) as typeof fetch;
    try {
      const first = await authLoginSource.startCursorBrowserLogin();
      await expect(
        authLoginSource.waitForCursorBrowserLogin(),
      ).rejects.toThrow("Poll failed: 401");

      globalThis.fetch = (async () =>
        new Response("", { status: 404 })) as typeof fetch;
      const method = hooks.auth?.methods[0];
      if (!method || method.type !== "oauth") throw new Error("Missing OAuth method");
      const second = await method.authorize();
      expect(second.url).not.toBe(first.url);
    } finally {
      globalThis.fetch = originalFetch;
      authLoginSource.resetPendingCursorLogin();
    }
  });

  test("writes background credentials atomically with owner-only permissions", async () => {
    const home = setDataHome("successful-login");
    const directory = join(home, "opencode");
    const authPath = join(directory, "auth.json");
    await mkdir(directory, { recursive: true });
    await writeFile(authPath, JSON.stringify({ other: { type: "api", key: "x" } }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        accessToken: "synthetic-browser-access",
        refreshToken: syntheticJwt("browser-refresh"),
      })) as typeof fetch;
    try {
      await authLoginSource.startCursorBrowserLogin();
      await authLoginSource.waitForCursorBrowserLogin();

      const stored = JSON.parse(await readFile(authPath, "utf8")) as Record<
        string,
        unknown
      >;
      expect(stored.other).toEqual({ type: "api", key: "x" });
      expect(stored.cursor).toMatchObject({
        type: "oauth",
        access: "synthetic-browser-access",
      });
      expect((await stat(authPath)).mode & 0o777).toBe(0o600);
    } finally {
      globalThis.fetch = originalFetch;
      authLoginSource.resetPendingCursorLogin();
    }
  });

  test("does not replace a malformed auth store", async () => {
    const home = setDataHome("malformed-auth-store");
    const directory = join(home, "opencode");
    const authPath = join(directory, "auth.json");
    await mkdir(directory, { recursive: true });
    await writeFile(authPath, "{malformed");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        accessToken: "synthetic-browser-access",
        refreshToken: syntheticJwt("browser-refresh"),
      })) as typeof fetch;
    try {
      await authLoginSource.startCursorBrowserLogin();
      await expect(
        authLoginSource.waitForCursorBrowserLogin(),
      ).rejects.toThrow("OpenCode auth store could not be read safely");
      expect(await readFile(authPath, "utf8")).toBe("{malformed");
    } finally {
      globalThis.fetch = originalFetch;
      authLoginSource.resetPendingCursorLogin();
    }
  });

  test("does not replace existing credentials after a malformed poll success", async () => {
    const home = setDataHome("malformed-poll");
    const directory = join(home, "opencode");
    const authPath = join(directory, "auth.json");
    const originalStore = `${JSON.stringify({
      other: { type: "api", key: "preserve" },
      cursor: { type: "oauth", access: "old", refresh: "old", expires: 1 },
    })}\n`;
    await mkdir(directory, { recursive: true });
    await writeFile(authPath, originalStore);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({})) as typeof fetch;
    try {
      await authLoginSource.startCursorBrowserLogin();
      await expect(
        authLoginSource.waitForCursorBrowserLogin(),
      ).rejects.toThrow("Cursor auth poll returned an invalid response");
      expect(await readFile(authPath, "utf8")).toBe(originalStore);
    } finally {
      globalThis.fetch = originalFetch;
      authLoginSource.resetPendingCursorLogin();
    }
  });

  test("ignores a stale poll after a replacement login starts", async () => {
    const home = setDataHome("replaced-login");
    const authPath = join(home, "opencode", "auth.json");
    let markPollStarted: (() => void) | undefined;
    const pollStarted = new Promise<void>((resolve) => {
      markPollStarted = resolve;
    });
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        markPollStarted?.();
        await Bun.sleep(150);
        return Response.json({
          accessToken: "stale-access",
          refreshToken: syntheticJwt("stale-refresh"),
        });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      await authLoginSource.startCursorBrowserLogin();
      await pollStarted;
      authLoginSource.resetPendingCursorLogin();
      const replacement = await authLoginSource.startCursorBrowserLogin();
      await Bun.sleep(200);

      expect(authLoginSource.getPendingCursorLogin()?.uuid).toBe(
        replacement.uuid,
      );
      expect(authLoginSource.getPendingCursorLogin()?.completed).toBe(false);
      await expect(stat(authPath)).rejects.toHaveProperty("code", "ENOENT");
    } finally {
      globalThis.fetch = originalFetch;
      authLoginSource.resetPendingCursorLogin();
    }
  });
});

describe("Cursor plugin lifecycle", () => {
  test("logged-out config exposes one login placeholder and reuses its browser login", async () => {
    setDataHome("logged-out");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("api2.cursor.sh/auth/poll")) {
        return new Response("", { status: 404 });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const otherProvider = { npm: "synthetic-other-adapter" };
      const userModel = { name: "User model" };
      const config: Record<string, unknown> = {
        provider: {
          other: otherProvider,
          cursor: {
            name: "Cursor fixture",
            npm: "synthetic-user-adapter",
            options: { syntheticOption: true },
            models: { "user-model": userModel },
          },
        },
      };
      if (!hooks.config) throw new Error("Missing config hook");
      await hooks.config(config);

      const providers = asRecord(config.provider);
      expect(providers.other).toEqual(otherProvider);
      const cursor = asRecord(providers.cursor);
      const options = asRecord(cursor.options);
      const configuredModels = asRecord(cursor.models);
      expect(cursor.name).toBe("Cursor fixture");
      expect(cursor.npm).toBe("synthetic-user-adapter");
      expect(options).toMatchObject({
        baseURL: LOGICAL_BASE_URL,
        includeUsage: true,
        syntheticOption: true,
      });
      expect(configuredModels["user-model"]).toEqual(userModel);
      expect(Object.keys(configuredModels).sort()).toEqual(["default", "user-model"]);
      const placeholder = asRecord(configuredModels.default);
      expect(placeholder.name).toBeString();
      expect(String(placeholder.name)).toStartWith("OPEN THIS URL TO LOGIN");

      const pending = authLoginSource.getPendingCursorLogin();
      expect(pending).not.toBeNull();
      const method = hooks.auth?.methods[0];
      if (!method || method.type !== "oauth") throw new Error("Missing OAuth method");
      const authorization = await method.authorize();
      expect(authorization.url).toBe(pending?.url);

      const provider = fakeProvider();
      await requireProviderModels()(provider as never, { auth: authValue() });
      expect(configuredModels.default).toBeUndefined();
      expect(configuredModels["user-model"]).toEqual(userModel);
    } finally {
      globalThis.fetch = originalFetch;
      authLoginSource.resetPendingCursorLogin();
    }
  });

  test("authenticated config advertises only filtered live models", async () => {
    const home = setDataHome("authenticated-config");
    await writeStoredAuth(home, sharedAuth);
    const config: Record<string, unknown> = {};
    if (!hooks.config) throw new Error("Missing config hook");

    await hooks.config(config);

    const cursor = asRecord(asRecord(config.provider).cursor);
    const models = asRecord(cursor.models);
    expect(cursor.npm).toBe("@ai-sdk/openai-compatible");
    expect(asRecord(cursor.options).baseURL).toBe(LOGICAL_BASE_URL);
    expect(Object.keys(models)).toEqual([
      "claude-fixture",
      "gemini-fixture",
      "gpt-fixture",
    ]);
    const claude = asRecord(models["claude-fixture"]);
    expect(claude.cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    });
    expect(claude).toMatchObject({
      attachment: true,
      tool_call: true,
      modalities: { input: ["text", "image"], output: ["text"] },
    });
  });

  test("loader returns only the direct custom fetch and supported models", async () => {
    const provider = fakeProvider();
    const loaded = await requireLoader()(
      async () => authValue(),
      provider as never,
    );

    expect(Object.keys(loaded).sort()).toEqual(["apiKey", "fetch"]);
    expect(loaded.apiKey).toBe("");
    expect(loaded.fetch).toBeFunction();
    expect("baseURL" in loaded).toBe(false);
    expect(Object.keys(provider.models)).toEqual([
      "claude-fixture",
      "gemini-fixture",
      "gpt-fixture",
    ]);
    const discovered = asRecord(provider.models["claude-fixture"]);
    expect(discovered.api).toEqual({
      id: "claude-fixture",
      url: LOGICAL_BASE_URL,
      npm: "@ai-sdk/openai-compatible",
    });
    expect(String(asRecord(discovered.api).url)).not.toContain("localhost");
    expect(discovered.capabilities).toMatchObject({
      attachment: true,
      toolcall: true,
      input: { image: true },
      output: { image: false },
    });
  });

  test("failed discovery keeps the provider visible but makes the loader unavailable", async () => {
    discoveryFailure = true;
    sharedAuth.access = "failure-token";
    const provider = fakeProvider();
    const providerModels = await requireProviderModels()(provider as never, {
      auth: authValue(),
    });
    const loaded = await requireLoader()(
      async () => authValue(),
      fakeProvider() as never,
    );

    expect(Object.keys(providerModels)).toEqual(["default"]);
    expect(loaded).toEqual({});
  });

  test("each loader fetch retains its own discovered catalog", async () => {
    const first = await requireLoader()(
      async () => authValue(),
      fakeProvider() as never,
    );
    if (typeof first.fetch !== "function") throw new Error("Missing direct fetch");

    discoveryFailure = true;
    sharedAuth.access = "failure-token";
    await requireLoader()(async () => authValue(), fakeProvider() as never);

    const headersHook = hooks["chat.headers"];
    if (!headersHook) throw new Error("Missing chat headers hook");
    const headerOutput = { headers: {} };
    await headersHook(
      {
        model: { id: "claude-fixture", providerID: "cursor" },
        message: { model: { variant: "high" } },
      } as Parameters<typeof headersHook>[0],
      headerOutput,
    );
    const response = await first.fetch(
      new Request(`${LOGICAL_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headerOutput.headers,
        },
        body: JSON.stringify({
          model: "claude-fixture",
          stream: false,
          messages: [{ role: "user", content: "synthetic request" }],
        }),
      }),
    );
    expect(response.status).toBe(404);
  });

  test("exposes transport disposal", () => {
    expect(hooks.dispose).toBeFunction();
  });

  test("chat hooks emit loader-resolved selection requests and strip private options", async () => {
    await requireLoader()(async () => authValue(), fakeProvider() as never);
    const headersHook = hooks["chat.headers"];
    const paramsHook = hooks["chat.params"];
    if (!headersHook || !paramsHook) throw new Error("Missing chat hooks");
    const hookInput = (variant: string) =>
      ({
        model: { id: "claude-fixture", providerID: "cursor" },
        message: { model: { variant } },
      }) as Parameters<typeof headersHook>[0];

    const output = { headers: {} };
    await headersHook(hookInput("high"), output);
    expect(output.headers).toEqual({
      [selectionSource.CURSOR_SELECTION_HEADER]:
        selectionSource.encodeCursorModelRequest({
          modelId: "claude-fixture",
          variant: "high",
        }),
    });
    const unknownOutput = { headers: {} };
    await headersHook(hookInput("unknown"), unknownOutput);
    expect(unknownOutput.headers).toEqual({
      [selectionSource.CURSOR_SELECTION_HEADER]:
        selectionSource.encodeCursorModelRequest({
          modelId: "claude-fixture",
          variant: "unknown",
        }),
    });

    const paramsOutput = {
      options: {
        reasoningEffort: "high",
        cursorVariant: "high",
        keep: "synthetic",
      },
    } as Parameters<typeof paramsHook>[1];
    await paramsHook(hookInput("high"), paramsOutput);
    expect(paramsOutput.options).toEqual({ keep: "synthetic" });
  });
});

describe("Cursor refresh lifecycle", () => {
  test("deduplicates concurrent loader/model refreshes and stores JWT rotation", async () => {
    const replacement = syntheticJwt("race-replacement");
    sharedAuth = {
      type: "oauth",
      access: "expired-race-access",
      refresh: syntheticJwt("race-original"),
      expires: Date.now() - 1,
    };
    refreshReplies = [
      {
        status: 200,
        body: { accessToken: "race-access", refreshToken: replacement },
        delayMs: 30,
      },
    ];
    const refreshBefore = refreshRequestCount;
    const writesBefore = credentialWrites;
    const loader = requireLoader();
    const providerModels = requireProviderModels();
    const providers = Array.from({ length: 5 }, () => fakeProvider());

    const results = await Promise.all([
      loader(async () => authValue(), providers[0] as never),
      providerModels(providers[1] as never, { auth: authValue() }),
      loader(async () => authValue(), providers[2] as never),
      providerModels(providers[3] as never, { auth: authValue() }),
      loader(async () => authValue(), providers[4] as never),
    ]);

    expect(results.every((result) => Object.keys(result).length > 0)).toBe(true);
    expect(refreshRequestCount - refreshBefore).toBe(1);
    expect(credentialWrites - writesBefore).toBe(1);
    expect(sharedAuth.access).toBe("race-access");
    expect(sharedAuth.refresh).toBe(replacement);
  });

  test("preserves an original JWT, adopts JWT rotation, and sanitizes refresh errors", async () => {
    const original = syntheticJwt("direct-original");
    const replacement = syntheticJwt("direct-replacement");
    const expired = syntheticJwt("expired-replacement", 0);
    const privateBody = "synthetic-private-response-body";
    refreshReplies = [
      {
        status: 200,
        body: { accessToken: "opaque-access-one", refreshToken: "opaque-refresh" },
      },
      {
        status: 200,
        body: { accessToken: "opaque-access-two", refreshToken: "one.two.three" },
      },
      {
        status: 200,
        body: { accessToken: replacement, refreshToken: replacement },
      },
      {
        status: 200,
        body: { accessToken: "opaque-access-expired", refreshToken: expired },
      },
      {
        status: 200,
        body: { accessToken: "opaque-access-three", refreshToken: replacement },
      },
      { status: 200, body: "not-json" },
      { status: 401, body: privateBody },
    ];

    expect((await authSource.refreshCursorToken(original)).refresh).toBe(original);
    expect((await authSource.refreshCursorToken(original)).refresh).toBe(original);
    expect((await authSource.refreshCursorToken(original)).refresh).toBe(original);
    expect((await authSource.refreshCursorToken(original)).refresh).toBe(original);
    expect((await authSource.refreshCursorToken(original)).refresh).toBe(
      replacement,
    );
    await expect(authSource.refreshCursorToken(original)).rejects.toThrow(
      "Cursor token refresh returned an invalid response",
    );
    let rejected: unknown;
    try {
      await authSource.refreshCursorToken(original);
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(authSource.RefreshTokenInvalidError);
    expect((rejected as Error).message).toBe(
      "Cursor token refresh rejected (HTTP 401)",
    );
    expect((rejected as Error).message).not.toContain(privateBody);
  });

  test("allows a later loader call to retry a transient refresh failure", async () => {
    const original = syntheticJwt("transient-original");
    sharedAuth = {
      type: "oauth",
      access: "expired-transient-access",
      refresh: original,
      expires: Date.now() - 1,
    };
    refreshReplies = [
      { status: 500, body: "synthetic transient failure" },
      {
        status: 200,
        body: { accessToken: "transient-access", refreshToken: "opaque-refresh" },
      },
    ];
    const refreshBefore = refreshRequestCount;
    const writesBefore = credentialWrites;
    const loader = requireLoader();

    const first = await loader(
      async () => authValue(),
      fakeProvider() as never,
    );
    const second = await loader(
      async () => authValue(),
      fakeProvider() as never,
    );

    expect(first).toEqual({});
    expect(Object.keys(second).sort()).toEqual(["apiKey", "fetch"]);
    expect(refreshRequestCount - refreshBefore).toBe(2);
    expect(credentialWrites - writesBefore).toBe(1);
    expect(sharedAuth.refresh).toBe(original);
    expect(sharedAuth.access).toBe("transient-access");
  });
});
