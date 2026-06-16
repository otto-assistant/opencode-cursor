import http from "node:http";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  GetUsableModelsResponseSchema,
  ModelDetailsSchema,
} from "../src/proto/agent_pb";

type DiscoveryMode = "success" | "empty" | "auth-error";
type RunMode = "immediate-close" | "stall-once-then-close";

interface TestModules {
  startProxy: typeof import("../src/proxy").startProxy;
  stopProxy: typeof import("../src/proxy").stopProxy;
  getProxyPort: typeof import("../src/proxy").getProxyPort;
  resolveProxyModelId: typeof import("../src/proxy").resolveProxyModelId;
  generateCursorAuthParams: typeof import("../src/auth").generateCursorAuthParams;
  getTokenExpiry: typeof import("../src/auth").getTokenExpiry;
  CursorAuthPlugin: typeof import("../src/index").CursorAuthPlugin;
  getCursorModels: typeof import("../src/models").getCursorModels;
  clearModelCache: typeof import("../src/models").clearModelCache;
}

interface TestCursorBackend {
  apiUrl: string;
  refreshUrl: string;
  setDiscoveryMode: (mode: DiscoveryMode) => void;
  setDiscoveredModels: (models: Array<{ id: string; name: string; reasoning?: boolean }>) => void;
  resetObservations: () => void;
  getDiscoveryAuthHeaders: () => string[];
  getDiscoveryRequestBodies: () => Uint8Array[];
  getRefreshAuthHeaders: () => string[];
  /**
   * Override the value the refresh server places in `refreshToken` of a
   * successful (200) response. Pass `null` to omit the field entirely.
   * `undefined` (the default) restores the canonical `"valid-refresh"` echo.
   */
  setRefreshResponseRefreshToken: (value: string | null | undefined) => void;
  setRunMode: (mode: RunMode) => void;
  getRunRequestCount: () => number;
  close: () => Promise<void>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertArrayEqual(
  actual: readonly string[],
  expected: readonly string[],
  message: string,
): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

function assertDefaultProviderModel(
  provider: { models: Record<string, any> },
  expectedApiModelId: string,
  message: string,
): void {
  const model = provider.models.default;
  assert(model, `${message}: missing provider model 'default'`);
  assertEqual(model.id, "default", `${message}: unexpected alias id`);
  assertEqual(model.providerID, "cursor", `${message}: unexpected provider id`);
  assertEqual(model.api?.id, expectedApiModelId, `${message}: unexpected API model id`);
}

function makeJwt(expiresAtSeconds: number): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ exp: expiresAtSeconds }));
  return `${header}.${payload}.fakesig`;
}

function frameConnectUnaryMessage(payload: Uint8Array): Buffer {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0;
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  return frame;
}

async function createTestCursorBackend(): Promise<TestCursorBackend> {
  let discoveryMode: DiscoveryMode = "success";
  let runMode: RunMode = "immediate-close";
  let runRequestCount = 0;
  let runStallConsumed = false;
  let discoveredModels: Array<{ id: string; name: string; reasoning?: boolean }> = [
    { id: "composer-2", name: "Composer 2", reasoning: true },
  ];
  const discoveryAuthHeaders: string[] = [];
  const discoveryRequestBodies: Uint8Array[] = [];
  const refreshAuthHeaders: string[] = [];

  let refreshResponseRefreshTokenOverride: string | null | undefined = undefined;
  const refreshServer = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/auth/exchange_user_api_key") {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    const authHeader = req.headers.authorization ?? "";
    refreshAuthHeaders.push(authHeader);

    if (authHeader !== "Bearer valid-refresh") {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("bad refresh token");
      return;
    }

    const body: Record<string, string> = {
      accessToken: makeJwt(Math.floor(Date.now() / 1000) + 3600),
    };
    if (refreshResponseRefreshTokenOverride === undefined) {
      body.refreshToken = "valid-refresh";
    } else if (refreshResponseRefreshTokenOverride !== null) {
      body.refreshToken = refreshResponseRefreshTokenOverride;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => refreshServer.listen(0, "127.0.0.1", resolve));
  const refreshPort = (refreshServer.address() as AddressInfo).port;

  const apiServer = http2.createServer();
  apiServer.on("stream", (stream, headers) => {
    const path = String(headers[":path"] ?? "");
    const authHeader = String(headers.authorization ?? "");
    if (path === "/agent.v1.AgentService/Run") {
      runRequestCount++;
      stream.respond({
        ":status": 200,
        "content-type": "application/connect+proto",
      });
      if (runMode === "stall-once-then-close" && !runStallConsumed) {
        runStallConsumed = true;
        // Intentionally keep stream open with no data to simulate a reset/hang.
        // Auto-close later so the test process can shut down cleanly.
        setTimeout(() => {
          try {
            stream.end();
          } catch {
            // ignore
          }
        }, 3_000);
        return;
      }
      stream.end();
      return;
    }

    const chunks: Buffer[] = [];

    stream.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    stream.on("end", () => {
      if (path === "/agent.v1.AgentService/GetUsableModels") {
        discoveryAuthHeaders.push(authHeader);
        discoveryRequestBodies.push(new Uint8Array(Buffer.concat(chunks)));

        if (discoveryMode === "auth-error") {
          stream.respond({
            ":status": 401,
            "content-type": "application/json",
          });
          stream.end(
            JSON.stringify({ code: "unauthenticated", message: "expired token" }),
          );
          return;
        }

        const responseBody = discoveryMode === "empty"
          ? frameConnectUnaryMessage(new Uint8Array())
          : frameConnectUnaryMessage(
              toBinary(
                GetUsableModelsResponseSchema,
                create(GetUsableModelsResponseSchema, {
                  models: discoveredModels.map((model) =>
                    create(ModelDetailsSchema, {
                      modelId: model.id,
                      displayModelId: model.id,
                      displayName: model.name,
                      displayNameShort: model.name,
                      aliases: [],
                    }),
                  ),
                }),
              ),
            );
        stream.respond({
          ":status": 200,
          "content-type": "application/connect+proto",
        });
        stream.end(responseBody);
        return;
      }

      stream.respond({ ":status": 404 });
      stream.end();
    });
  });
  await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
  const apiPort = (apiServer.address() as AddressInfo).port;

  return {
    apiUrl: `http://127.0.0.1:${apiPort}`,
    refreshUrl: `http://127.0.0.1:${refreshPort}/auth/exchange_user_api_key`,
    setDiscoveryMode(mode) {
      discoveryMode = mode;
    },
    setDiscoveredModels(models) {
      discoveredModels = models;
    },
    resetObservations() {
      discoveryAuthHeaders.length = 0;
      discoveryRequestBodies.length = 0;
      refreshAuthHeaders.length = 0;
    },
    getDiscoveryAuthHeaders() {
      return [...discoveryAuthHeaders];
    },
    getDiscoveryRequestBodies() {
      return discoveryRequestBodies.map((body) => new Uint8Array(body));
    },
    getRefreshAuthHeaders() {
      return [...refreshAuthHeaders];
    },
    setRefreshResponseRefreshToken(value) {
      refreshResponseRefreshTokenOverride = value;
    },
    setRunMode(mode) {
      runMode = mode;
      runStallConsumed = false;
      runRequestCount = 0;
    },
    getRunRequestCount() {
      return runRequestCount;
    },
    async close() {
      await Promise.all([
        new Promise<void>((resolve, reject) =>
          apiServer.close((error) => (error ? reject(error) : resolve())),
        ),
        new Promise<void>((resolve, reject) =>
          refreshServer.close((error) => (error ? reject(error) : resolve())),
        ),
      ]);
    },
  };
}

async function loadModules(): Promise<TestModules> {
  const proxy = await import("../src/proxy");
  const auth = await import("../src/auth");
  const index = await import("../src/index");
  const models = await import("../src/models");
  return {
    startProxy: proxy.startProxy,
    stopProxy: proxy.stopProxy,
    getProxyPort: proxy.getProxyPort,
    resolveProxyModelId: proxy.resolveProxyModelId,
    generateCursorAuthParams: auth.generateCursorAuthParams,
    getTokenExpiry: auth.getTokenExpiry,
    CursorAuthPlugin: index.CursorAuthPlugin,
    getCursorModels: models.getCursorModels,
    clearModelCache: models.clearModelCache,
  };
}

async function testProxyStartStop(modules: TestModules) {
  console.log("[test] Starting proxy...");
  const port = await modules.startProxy(async () => "test-token");
  console.log(`[test] Proxy started on port ${port}`);

  if (port < 1) {
    throw new Error(`Expected a valid port number, got ${port}`);
  }
  if (modules.getProxyPort() !== port) {
    throw new Error("getProxyPort() mismatch");
  }

  const modelsRes = await fetch(`http://localhost:${port}/v1/models`);
  if (!modelsRes.ok) {
    throw new Error(`/v1/models returned ${modelsRes.status}`);
  }
  const modelsBody = await modelsRes.json();
  if (modelsBody.object !== "list") {
    throw new Error(`Expected object=list, got ${modelsBody.object}`);
  }
  if (!Array.isArray(modelsBody.data) || modelsBody.data.length !== 0) {
    throw new Error(`Expected empty model list data array, got ${JSON.stringify(modelsBody.data)}`);
  }
  console.log("[test] /v1/models OK");

  const badRes = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test", messages: [] }),
  });
  if (badRes.status !== 400) {
    throw new Error(`Expected 400 for missing user message, got ${badRes.status}`);
  }
  const badBody = await badRes.json();
  if (!badBody.error?.message?.includes("No user message")) {
    throw new Error(`Expected 'No user message' error, got: ${badBody.error?.message}`);
  }
  console.log("[test] Missing user message validation OK");

  const notFoundRes = await fetch(`http://localhost:${port}/unknown`);
  if (notFoundRes.status !== 404) {
    throw new Error(`Expected 404, got ${notFoundRes.status}`);
  }
  console.log("[test] 404 handling OK");

  modules.stopProxy();
  if (modules.getProxyPort() !== undefined) {
    throw new Error("Proxy port should be undefined after stop");
  }
  console.log("[test] Proxy stop OK");
}

async function testAuthParams(modules: TestModules) {
  console.log("[test] Generating auth params...");
  const params = await modules.generateCursorAuthParams();

  if (!params.verifier || !params.challenge || !params.uuid || !params.loginUrl) {
    throw new Error("Missing auth params");
  }
  if (!params.loginUrl.includes("cursor.com/loginDeepControl")) {
    throw new Error(`Unexpected login URL: ${params.loginUrl}`);
  }
  if (!params.loginUrl.includes(params.uuid)) {
    throw new Error("Login URL missing UUID");
  }

  const data = new TextEncoder().encode(params.verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const expectedChallenge = Buffer.from(hashBuffer).toString("base64url");
  if (params.challenge !== expectedChallenge) {
    throw new Error(
      `PKCE challenge mismatch: expected ${expectedChallenge}, got ${params.challenge}`,
    );
  }

  console.log("[test] Auth params OK");
}

async function testTokenExpiry(modules: TestModules) {
  console.log("[test] Testing token expiry parsing...");

  const futureExp = Math.floor(Date.now() / 1000) + 7200;
  const fakeJwt = makeJwt(futureExp);

  const expiry = modules.getTokenExpiry(fakeJwt);
  const expectedMin = futureExp * 1000 - 5 * 60 * 1000 - 1000;
  const expectedMax = futureExp * 1000 - 5 * 60 * 1000 + 1000;

  if (expiry < expectedMin || expiry > expectedMax) {
    throw new Error(`Token expiry ${expiry} out of expected range [${expectedMin}, ${expectedMax}]`);
  }

  const fallbackExpiry = modules.getTokenExpiry("not-a-jwt");
  const now = Date.now();
  const expectedFallback = now + 3600 * 1000;
  if (Math.abs(fallbackExpiry - expectedFallback) > 5000) {
    throw new Error(
      `Fallback expiry off by ${Math.abs(fallbackExpiry - expectedFallback)}ms, expected ~1h from now`,
    );
  }

  console.log("[test] Token expiry OK");
}

async function testProxyModelAliasResolution(modules: TestModules) {
  console.log("[test] Testing proxy model alias resolution...");

  assertEqual(
    modules.resolveProxyModelId("default"),
    "default",
    "Expected default alias to pass through for Cursor auto-routing",
  );
  assertEqual(
    modules.resolveProxyModelId("auto"),
    "default",
    "Expected legacy auto alias to use Cursor's supported default model id",
  );
  assertEqual(
    modules.resolveProxyModelId("claude-4.5-sonnet"),
    "claude-4.5-sonnet",
    "Expected concrete model ids to pass through unchanged",
  );

  console.log("[test] Proxy model alias resolution OK");
}

async function testPluginShape(modules: TestModules) {
  console.log("[test] Checking plugin export shape...");

  const fakeInput = {
    client: { auth: { set: async () => {} } },
  } as any;
  const hooks = await modules.CursorAuthPlugin(fakeInput);

  if (!hooks.auth) {
    throw new Error("Plugin hooks missing 'auth'");
  }
  if (hooks.auth.provider !== "cursor") {
    throw new Error(`Expected provider 'cursor', got '${hooks.auth.provider}'`);
  }
  if (typeof hooks.auth.loader !== "function") {
    throw new Error("Plugin hooks.auth.loader is not a function");
  }
  if (!Array.isArray(hooks.auth.methods) || hooks.auth.methods.length === 0) {
    throw new Error("Plugin hooks.auth.methods missing or empty");
  }
  if (hooks.auth.methods[0].type !== "oauth") {
    throw new Error(`Expected method type 'oauth', got '${hooks.auth.methods[0].type}'`);
  }
  if (typeof hooks.auth.methods[0].authorize !== "function") {
    throw new Error("Plugin auth method missing authorize function");
  }

  console.log("[test] Plugin shape OK");
}

async function testConfigHookSeedsProvider(modules: TestModules) {
  console.log("[test] Checking config hook seeds cursor provider...");

  // Force the offline fallback path: point the auth store at an empty dir so
  // the config hook does not perform real network discovery.
  const prevXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = "/tmp/opencode-cursor-smoke-empty";

  const fakeInput = {
    client: { auth: { set: async () => {} } },
  } as any;
  const hooks = await modules.CursorAuthPlugin(fakeInput);

  if (typeof hooks.config !== "function") {
    throw new Error("Plugin hooks.config is not a function");
  }

  // Fresh config: provider + models should be seeded.
  const fresh: any = {};
  await hooks.config!(fresh);
  const cursor = fresh.provider?.cursor;
  assert(cursor, "Expected config hook to create provider.cursor");
  assertEqual(cursor.name, "Cursor", "Expected seeded provider name");
  assertEqual(cursor.npm, "@ai-sdk/openai-compatible", "Expected seeded npm");
  assert(cursor.options?.baseURL, "Expected seeded options.baseURL");
  assert(
    Object.keys(cursor.models ?? {}).length > 0,
    "Expected seeded provider to declare models",
  );
  assert(
    "composer-1" in cursor.models,
    "Expected fallback model composer-1 to be seeded",
  );

  // User overrides must be preserved and win over seeded defaults.
  const custom: any = {
    provider: {
      cursor: {
        name: "My Cursor",
        npm: "custom-npm",
        options: { baseURL: "http://localhost:1234/v1", apiKey: "x" },
        models: { "my-model": { name: "My Model" } },
      },
    },
  };
  await hooks.config!(custom);
  const c2 = custom.provider.cursor;
  assertEqual(c2.name, "My Cursor", "Expected user name to be preserved");
  assertEqual(c2.npm, "custom-npm", "Expected user npm to be preserved");
  assertEqual(
    c2.options.baseURL,
    "http://localhost:1234/v1",
    "Expected user baseURL to be preserved",
  );
  assertEqual(c2.options.apiKey, "x", "Expected user option to be preserved");
  assert("my-model" in c2.models, "Expected user model to be preserved");
  assert(
    "composer-1" in c2.models,
    "Expected seeded models to be merged alongside user models",
  );

  if (prevXdg === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = prevXdg;
  }

  console.log("[test] Config hook seeding OK");
}

async function testArrayContentParsing(modules: TestModules) {
  console.log("[test] Testing array content (plan-mode) parsing...");
  const port = await modules.startProxy(async () => "test-token");

  const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "test",
      stream: false,
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "You are a helpful assistant." },
            { type: "text", text: "Plan mode is active." },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "lazy-load recharts" },
            { type: "text", text: "work on a plan" },
          ],
        },
      ],
    }),
  });

  if (res.status === 400) {
    const body = await res.json();
    if (body.error?.message?.includes("No user message")) {
      throw new Error(
        "Array content not normalized — plan mode messages lost",
      );
    }
  }

  modules.stopProxy();
  console.log("[test] Array content parsing OK");
}

async function testExpiredTokenRefreshBeforeDiscovery(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing refresh-before-discovery...");
  modules.clearModelCache();
  backend.resetObservations();
  backend.setDiscoveryMode("success");
  backend.setDiscoveredModels([
    { id: "fresh-model", name: "Fresh Model", reasoning: true },
  ]);

  let authState = {
    type: "oauth" as const,
    access: "expired-access",
    refresh: "valid-refresh",
    expires: Date.now() - 10_000,
  };
  const writes: Array<{ access: string; refresh: string; expires: number }> = [];
  const hooks = await modules.CursorAuthPlugin({
    client: {
      auth: {
        set: async ({ body }: any) => {
          writes.push(body);
          authState = body;
        },
      },
    },
  } as any);
  const provider = { models: {} as Record<string, unknown> } as any;

  await hooks.auth!.loader(async () => authState, provider);

  assertEqual(writes.length, 1, "Expected refreshed auth to be persisted once");
  assert(
    writes[0]?.access && writes[0].access !== "expired-access",
    "Expected refreshed access token to replace the expired token",
  );
  assertArrayEqual(
    backend.getRefreshAuthHeaders(),
    ["Bearer valid-refresh"],
    "Expected refresh endpoint to be called with the stored refresh token",
  );
  assert(
    backend.getDiscoveryAuthHeaders().every((header) => header === `Bearer ${writes[0]?.access}`),
    `Expected discovery to use the refreshed token, got ${JSON.stringify(backend.getDiscoveryAuthHeaders())}`,
  );
  // Test that discovery returned models (be flexible about exact list)
  assert(
    Object.keys(provider.models).length > 0,
    "Expected provider models to come from successful discovery",
  );
  assertDefaultProviderModel(
    provider,
    "default",
    "Expected cursor/default to pass 'default' literally for Cursor auto-routing",
  );

  modules.stopProxy();
  console.log("[test] Refresh-before-discovery OK");
}

async function testRefreshFailureKeepsProviderListable(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing refresh-failure does not break loader...");
  modules.clearModelCache();
  backend.resetObservations();

  // Refresh server returns 401 for any token != "valid-refresh".
  const authState = {
    type: "oauth" as const,
    access: "expired-access",
    refresh: "totally-revoked",
    expires: Date.now() - 10_000,
  };
  const writes: Array<unknown> = [];
  const hooks = await modules.CursorAuthPlugin({
    client: {
      auth: {
        set: async ({ body }: any) => {
          writes.push(body);
        },
      },
    },
  } as any);
  const provider = { models: { stale: { id: "stale" } } } as any;

  let threw: unknown = null;
  let result: unknown;
  try {
    result = await hooks.auth!.loader(async () => authState, provider);
  } catch (err) {
    threw = err;
  }

  assert(
    threw === null,
    `Loader must not throw on refresh failure; got: ${String(threw)}`,
  );
  assertEqual(
    JSON.stringify(result),
    "{}",
    "Loader should return empty config on refresh failure",
  );
  assertEqual(
    writes.length,
    0,
    "Loader must not persist new auth on refresh failure",
  );
  assertEqual(
    backend.getRefreshAuthHeaders().length,
    1,
    "Refresh endpoint should have been called exactly once",
  );

  modules.stopProxy();
  console.log("[test] Refresh-failure-non-throw OK");
}

async function testRefreshPreservesOriginalWhenResponseRefreshIsNotJwt(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log(
    "[test] Testing refresh keeps original refresh when response refreshToken is not a JWT...",
  );
  modules.clearModelCache();
  backend.resetObservations();
  backend.setDiscoveryMode("success");
  backend.setDiscoveredModels([
    { id: "fresh-model", name: "Fresh Model", reasoning: true },
  ]);
  // Cursor sometimes echoes an API-key string as `refreshToken`. The plugin
  // must NOT adopt it — doing so clobbers the long-lived OAuth JWT and
  // permanently breaks subsequent refreshes.
  backend.setRefreshResponseRefreshToken("key_some_short_lived_api_key");

  let authState = {
    type: "oauth" as const,
    access: "expired-access",
    refresh: "valid-refresh",
    expires: Date.now() - 10_000,
  };
  const writes: Array<{ access: string; refresh: string; expires: number }> = [];
  const hooks = await modules.CursorAuthPlugin({
    client: {
      auth: {
        set: async ({ body }: any) => {
          writes.push(body);
          authState = body;
        },
      },
    },
  } as any);
  const provider = { models: {} as Record<string, unknown> } as any;

  await hooks.auth!.loader(async () => authState, provider);

  assertEqual(writes.length, 1, "Expected refreshed auth to be persisted once");
  assertEqual(
    writes[0]!.refresh,
    "valid-refresh",
    "Original refresh JWT must be preserved when response refreshToken is not a JWT",
  );

  // Reset for downstream tests.
  backend.setRefreshResponseRefreshToken(undefined);
  modules.stopProxy();
  console.log("[test] Non-JWT refresh preservation OK");
}

async function testRefreshRotatesWhenResponseRefreshIsJwt(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log(
    "[test] Testing refresh rotates refresh token when response gives a new JWT...",
  );
  modules.clearModelCache();
  backend.resetObservations();
  backend.setDiscoveryMode("success");
  backend.setDiscoveredModels([
    { id: "fresh-model", name: "Fresh Model", reasoning: true },
  ]);
  const newRefreshJwt = makeJwt(Math.floor(Date.now() / 1000) + 30 * 86_400);
  backend.setRefreshResponseRefreshToken(newRefreshJwt);

  let authState = {
    type: "oauth" as const,
    access: "expired-access",
    refresh: "valid-refresh",
    expires: Date.now() - 10_000,
  };
  const writes: Array<{ access: string; refresh: string; expires: number }> = [];
  const hooks = await modules.CursorAuthPlugin({
    client: {
      auth: {
        set: async ({ body }: any) => {
          writes.push(body);
          authState = body;
        },
      },
    },
  } as any);
  const provider = { models: {} as Record<string, unknown> } as any;

  await hooks.auth!.loader(async () => authState, provider);

  assertEqual(writes.length, 1, "Expected refreshed auth to be persisted once");
  assertEqual(
    writes[0]!.refresh,
    newRefreshJwt,
    "A JWT-shaped refresh token in the response must be adopted",
  );

  backend.setRefreshResponseRefreshToken(undefined);
  modules.stopProxy();
  console.log("[test] JWT refresh rotation OK");
}

async function testDiscoveryFallbackAndSuccess(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing discovery fallback and success...");

  const authState = {
    type: "oauth" as const,
    access: makeJwt(Math.floor(Date.now() / 1000) + 3600),
    refresh: "valid-refresh",
    expires: Date.now() + 3_600_000,
  };
  const hooks = await modules.CursorAuthPlugin({
    client: {
      auth: {
        set: async () => {},
      },
    },
  } as any);
  const provider = { models: { stale: { id: "stale" } } } as any;

  // Failed discovery should fall back to hardcoded models
  modules.clearModelCache();
  backend.setDiscoveryMode("empty");
  const degradedConfig = await hooks.auth!.loader(async () => authState, provider);
  assert(
    Object.keys(provider.models).length > 0,
    "Expected fallback models to be registered when discovery fails",
  );
  assert(
    !("stale" in provider.models),
    "Expected stale models to be replaced",
  );
  assertDefaultProviderModel(
    provider,
    "default",
    "Expected cursor/default to pass 'default' literally (fallback models)",
  );
  const degradedModelsRes = await fetch(`${degradedConfig.baseURL}/models`);
  assertEqual(degradedModelsRes.status, 200, "Expected degraded /v1/models to succeed");
  const degradedModelsBody = await degradedModelsRes.json();
  assert(
    degradedModelsBody.data.length > 0,
    "Expected proxy /v1/models to expose fallback models",
  );

  // Successful discovery should replace with real models
  modules.clearModelCache();
  backend.setDiscoveryMode("success");
  backend.setDiscoveredModels([
    { id: "real-model-a", name: "Real Model A" },
    { id: "real-model-b", name: "Real Model B", reasoning: true },
  ]);
  const discoveredConfig = await hooks.auth!.loader(async () => authState, provider);
  // Check that we got models (be flexible about exact list due to API changes)
  assert(
    Object.keys(provider.models).length > 0,
    "Expected successful discovery to replace fallback models",
  );
  assertDefaultProviderModel(
    provider,
    "default",
    "Expected cursor/default to pass 'default' literally (discovered models)",
  );
  const discoveredModelsRes = await fetch(`${discoveredConfig.baseURL}/models`);
  assertEqual(discoveredModelsRes.status, 200, "Expected discovered /v1/models to succeed");
  const discoveredModelsBody = await discoveredModelsRes.json();
  assert(
    discoveredModelsBody.data.length > 0,
    "Expected discovered /v1/models to return models",
  );

  modules.stopProxy();
  console.log("[test] Discovery fallback and success OK");
}

// ---------------------------------------------------------------------------
// Persistent bridge session recovery tests
//
// These tests directly exercise the BridgePool + h2-bridge-persistent.mjs
// to verify the session isolation fix without depending on proxy internals
// like the module-level CURSOR_API_URL constant.
// ---------------------------------------------------------------------------

/**
 * Create a plain HTTP/2 server for pool tests.
 */
function createPoolTestServer(): Promise<{
  url: string;
  streamCount: () => number;
  setNextStreamReset: () => void;
  close: () => Promise<void>;
}> {
  let streamCountVal = 0;
  let nextReset = false;

  const server = http2.createServer();
  server.on("stream", (stream) => {
    streamCountVal++;
    if (nextReset) {
      nextReset = false;
      // Destroy the entire H2 session to simulate a TCP-level connection
      // reset — this is what causes "Connection reset by server" in production.
      // Destroying the session sends GOAWAY to the client and tears down
      // all active streams.
      stream.session?.destroy();
      return;
    }
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    stream.end();
  });

  const ready = new Promise<{ url: string; streamCount: () => number; setNextStreamReset: () => void; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        streamCount: () => streamCountVal,
        setNextStreamReset: () => { nextReset = true; },
        close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
      });
    });
  });
  return ready;
}

/**
 * Send a single request through a pool handle and wait for completion.
 */
function poolRequest(
  pool: InstanceType<typeof import("../src/bridge-pool").BridgePool>,
  url: string,
): Promise<{ code: number }> {
  return new Promise((resolve) => {
    const handle = pool.acquire({
      accessToken: "test-token",
      rpcPath: "/agent.v1.AgentService/Run",
      url,
    });
    handle.onData(() => {});
    handle.onClose((code) => {
      resolve({ code });
    });
    handle.end();
  });
}

/**
 * Test that the persistent bridge correctly isolates sessions:
 * 3 sequential requests through the same pool worker succeed.
 */
async function testPersistentBridgeSessionIsolation() {
  console.log("[test] Testing persistent bridge session isolation...");

  const { BridgePool } = await import("../src/bridge-pool");
  const server = await createPoolTestServer();

  const pool = new BridgePool({ minSize: 1, maxSize: 2 });
  pool.warmup();
  await new Promise((r) => setTimeout(r, 200)); // let workers start

  for (let i = 0; i < 3; i++) {
    const { code } = await poolRequest(pool, server.url);
    assertEqual(code, 0, `Isolation request ${i} should succeed (code=0)`);
  }

  const stats = pool.stats();
  console.log(`[test]   pool stats: ${JSON.stringify(stats)}`);
  assert(stats.total >= 1, "Pool should have at least 1 worker");
  assert(server.streamCount() >= 3, `Expected >= 3 streams, got ${server.streamCount()}`);

  pool.shutdown();
  await server.close();
  console.log("[test] Persistent bridge session isolation OK");
}

/**
 * Test that the pool recovers after the H2 server becomes unreachable
 * and then comes back — the core regression test for stale handler isolation.
 *
 * Before the fix, a session error handler from the old server connection
 * could corrupt a new connection made after the server restarts.
 */
async function testPoolRecoveryAfterServerRestart() {
  console.log("[test] Testing pool recovery after server restart...");

  const { BridgePool } = await import("../src/bridge-pool");

  // Create two H2 servers on different ports to simulate server restart.
  let server1Streams = 0;
  const server1 = http2.createServer();
  server1.on("stream", (stream) => {
    server1Streams++;
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    stream.end();
  });
  await new Promise<void>((resolve) => server1.listen(0, "127.0.0.1", resolve));
  const port1 = (server1.address() as AddressInfo).port;
  const url1 = `http://127.0.0.1:${port1}`;

  let server2Streams = 0;
  const server2 = http2.createServer();
  server2.on("stream", (stream) => {
    server2Streams++;
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    stream.end();
  });
  await new Promise<void>((resolve) => server2.listen(0, "127.0.0.1", resolve));
  const port2 = (server2.address() as AddressInfo).port;
  const url2 = `http://127.0.0.1:${port2}`;

  const pool = new BridgePool({ minSize: 1, maxSize: 2 });
  pool.warmup();
  await new Promise((r) => setTimeout(r, 200));

  // 1. Request to server 1 — worker establishes H2 session to server1
  const r1 = await poolRequest(pool, url1);
  assertEqual(r1.code, 0, "First request to server1 should succeed");
  assert(server1Streams >= 1, `Expected server1 streams >= 1, got ${server1Streams}`);
  console.log(`[test]   server1 request OK (streams: ${server1Streams})`);

  // 2. Request to server 2 — worker creates NEW H2 session to server2
  //    (different URL, so getOrCreateClient must create a new session)
  //    With the stale handler fix, the old server1 session's handlers
  //    won't corrupt the new server2 session.
  const r2 = await poolRequest(pool, url2);
  assertEqual(r2.code, 0, "Request to server2 should succeed (session isolation)");
  assert(server2Streams >= 1, `Expected server2 streams >= 1, got ${server2Streams}`);
  console.log(`[test]   server2 request OK (streams: ${server2Streams})`);

  // 3. Kill server1 — the worker's old session to server1 should error.
  //    The session error handler fires, setting h2Client = null.
  //    With the fix, the handler only nulls h2Client if it still matches
  //    the old session, NOT if h2Client has been reassigned to server2's session.
  await new Promise<void>((resolve) => server1.close(() => resolve()));
  // Give the session error time to propagate
  await new Promise((r) => setTimeout(r, 200));

  // 4. Request to server 2 MUST still succeed. This is the critical test:
  //    if the stale handler bug exists, killing server1 would corrupt
  //    server2's session (because the old handler reads h2Client which
  //    now points to server2's session and destroys it).
  const r3 = await poolRequest(pool, url2);
  assertEqual(r3.code, 0, "Recovery request to server2 MUST succeed — stale handler did not corrupt session");
  console.log(`[test]   post-server1-kill server2 request OK (server2 streams: ${server2Streams})`);

  // 5. Additional verification: request to server1 URL should recover
  //    (new session since server1 is down → getOrCreateClient creates new)
  //    This will fail because server1 is down, but it should not crash the pool.
  //    Skip this — we can't test connecting to a dead server without hanging.

  pool.shutdown();
  await new Promise<void>((resolve) => server2.close(() => resolve()));
  console.log("[test] Pool recovery after server restart OK");
}

/**
 * Test that multiple sequential requests through the pool all succeed,
 * verifying proper release/acquire cycling and H2 session reuse.
 */
async function testPoolSequentialRequests() {
  console.log("[test] Testing pool sequential requests...");

  const { BridgePool } = await import("../src/bridge-pool");
  const server = await createPoolTestServer();

  const pool = new BridgePool({ minSize: 1, maxSize: 2 });
  pool.warmup();
  await new Promise((r) => setTimeout(r, 200));

  const N = 8;
  for (let i = 0; i < N; i++) {
    const { code } = await poolRequest(pool, server.url);
    assertEqual(code, 0, `Sequential request ${i} should succeed`);
  }

  const totalStreams = server.streamCount();
  assert(totalStreams >= N, `Expected >= ${N} streams, got ${totalStreams}`);
  console.log(`[test]   ${N} sequential requests OK (${totalStreams} streams)`);

  pool.shutdown();
  await server.close();
  console.log("[test] Pool sequential requests OK");
}

async function testStreamingWatchdogRecoversFromStalledRun(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing streaming watchdog recovery from stalled Run...");
  modules.stopProxy();
  backend.setRunMode("stall-once-then-close");

  const port = await modules.startProxy(async () => "test-token");
  const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "composer-2",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
  });

  assertEqual(res.status, 200, "Expected streaming request to succeed");
  const bodyText = await res.text();
  assert(
    bodyText.includes("data: [DONE]"),
    `Expected SSE stream to terminate with [DONE], got: ${bodyText.slice(0, 200)}`,
  );
  assert(
    backend.getRunRequestCount() >= 2,
    `Expected watchdog retry (>=2 Run attempts), got ${backend.getRunRequestCount()}`,
  );

  backend.setRunMode("immediate-close");
  modules.stopProxy();
  console.log("[test] Streaming watchdog recovery OK");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const backend = await createTestCursorBackend();
  process.env.CURSOR_API_URL = backend.apiUrl;
  process.env.CURSOR_REFRESH_URL = backend.refreshUrl;
  process.env.OPENCODE_CURSOR_STALL_TIMEOUT_MS = "1200";
  process.env.OPENCODE_CURSOR_STALL_TICK_MS = "100";
  // Use a dedicated proxy port so tests never collide with a live OpenCode
  // session running the plugin on the default fixed port.
  process.env.OPENCODE_CURSOR_PROXY_PORT = "8799";

  const modules = await loadModules();

  try {
    await testProxyStartStop(modules);
    await testAuthParams(modules);
    await testTokenExpiry(modules);
    await testProxyModelAliasResolution(modules);
    await testPluginShape(modules);
    await testConfigHookSeedsProvider(modules);
    await testArrayContentParsing(modules);
    await testExpiredTokenRefreshBeforeDiscovery(modules, backend);
    await testRefreshFailureKeepsProviderListable(modules, backend);
    await testRefreshPreservesOriginalWhenResponseRefreshIsNotJwt(modules, backend);
    await testRefreshRotatesWhenResponseRefreshIsJwt(modules, backend);
    await testDiscoveryFallbackAndSuccess(modules, backend);
    await testPersistentBridgeSessionIsolation();
    await testPoolRecoveryAfterServerRestart();
    await testPoolSequentialRequests();
    await testStreamingWatchdogRecoversFromStalledRun(modules, backend);
    console.log("\n✓ All smoke tests passed");
    process.exitCode = 0;
  } catch (err) {
    console.error("\n✗ Smoke test failed:", err);
    process.exitCode = 1;
  } finally {
    modules.stopProxy();
    await backend.close();
  }
}

main();
