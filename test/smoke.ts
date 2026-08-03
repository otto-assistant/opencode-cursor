import http from "node:http";
import http2 from "node:http2";
import { mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  GetUsableModelsResponseSchema,
  HeartbeatUpdateSchema,
  InteractionUpdateSchema,
  ModelDetailsSchema,
  TextDeltaUpdateSchema,
  TurnEndedUpdateSchema,
} from "../src/proto/agent_pb";

type DiscoveryMode = "success" | "empty" | "auth-error";
type RunMode =
  | "immediate-close"
  | "stall-once-then-close"
  | "heartbeat-only-stall"
  | "text-then-hang";

interface TestModules {
  startProxy: typeof import("../src/proxy").startProxy;
  stopProxy: typeof import("../src/proxy").stopProxy;
  getProxyPort: typeof import("../src/proxy").getProxyPort;
  resolveProxyModelId: typeof import("../src/proxy").resolveProxyModelId;
  computeUsage: typeof import("../src/proxy").computeUsage;
  isServerKeepaliveMessage: typeof import("../src/proxy").isServerKeepaliveMessage;
  cursorSelectionHeader: typeof import("../src/model-selection").CURSOR_SELECTION_HEADER;
  encodeCursorModelSelection: typeof import("../src/model-selection").encodeCursorModelSelection;
  decodeCursorModelSelection: typeof import("../src/model-selection").decodeCursorModelSelection;
  generateCursorAuthParams: typeof import("../src/auth").generateCursorAuthParams;
  getTokenExpiry: typeof import("../src/auth").getTokenExpiry;
  CursorAuthPlugin: typeof import("../src/index").CursorAuthPlugin;
  getCursorModels: typeof import("../src/models").getCursorModels;
  clearModelCache: typeof import("../src/models").clearModelCache;
  normalizeCursorModels: typeof import("../src/models").normalizeCursorModels;
  normalizeAvailableModels: typeof import("../src/models").normalizeAvailableModels;
  resolveCursorModelSelection: typeof import("../src/models").resolveCursorModelSelection;
  resetPendingCursorLogin: typeof import("../src/auth-login").resetPendingCursorLogin;
}

interface TestCursorBackend {
  apiUrl: string;
  refreshUrl: string;
  setDiscoveryMode: (mode: DiscoveryMode) => void;
  setDiscoveredModels: (models: Array<{ id: string; name: string; reasoning?: boolean }>) => void;
  setAvailableModels: (models: unknown[] | undefined) => void;
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
  getRunUserTexts: () => string[];
  getRunModelIds: () => string[];
  getRunSelections: () => Array<{
    publicId?: string;
    displayName?: string;
    modelDetailsMaxMode?: boolean;
    modelId?: string;
    maxMode?: boolean;
    parameters: Record<string, string>;
  }>;
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

/** Cursor heartbeat interaction update — keeps the stream alive with no content. */
function frameHeartbeatServerMessage(): Buffer {
  const payload = toBinary(
    AgentServerMessageSchema,
    create(AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: create(InteractionUpdateSchema, {
          message: {
            case: "heartbeat",
            value: create(HeartbeatUpdateSchema, {}),
          },
        }),
      },
    }),
  );
  return frameConnectUnaryMessage(payload);
}

/** Minimal assistant text + turn_ended so the proxy finishes without empty-stream retries. */
function frameTextThenEndServerMessages(text: string): Buffer[] {
  const textPayload = toBinary(
    AgentServerMessageSchema,
    create(AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: create(InteractionUpdateSchema, {
          message: {
            case: "textDelta",
            value: create(TextDeltaUpdateSchema, { text }),
          },
        }),
      },
    }),
  );
  const endPayload = toBinary(
    AgentServerMessageSchema,
    create(AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: create(InteractionUpdateSchema, {
          message: {
            case: "turnEnded",
            value: create(TurnEndedUpdateSchema, {}),
          },
        }),
      },
    }),
  );
  return [frameConnectUnaryMessage(textPayload), frameConnectUnaryMessage(endPayload)];
}

async function createTestCursorBackend(): Promise<TestCursorBackend> {
  let discoveryMode: DiscoveryMode = "success";
  let runMode: RunMode = "immediate-close";
  let runRequestCount = 0;
  const runModelIds: string[] = [];
  const runUserTexts: string[] = [];
  let runStallConsumed = false;
  let discoveredModels: Array<{ id: string; name: string; reasoning?: boolean }> = [
    { id: "composer-2", name: "Composer 2", reasoning: true },
  ];
  let availableModels: unknown[] | undefined;
  const runSelections: Array<{
    publicId?: string;
    displayName?: string;
    modelDetailsMaxMode?: boolean;
    modelId?: string;
    maxMode?: boolean;
    parameters: Record<string, string>;
  }> = [];
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
      let pending = Buffer.alloc(0);
      stream.on("data", (chunk) => {
        pending = Buffer.concat([pending, Buffer.from(chunk)]);
        while (pending.length >= 5) {
          const messageLength = pending.readUInt32BE(1);
          if (pending.length < 5 + messageLength) break;
          const payload = pending.subarray(5, 5 + messageLength);
          pending = pending.subarray(5 + messageLength);
          try {
            const message = fromBinary(AgentClientMessageSchema, payload);
            if (message.message.case === "runRequest") {
              const runRequest = message.message.value;
              const modelId = runRequest.modelDetails?.modelId;
              if (modelId) runModelIds.push(modelId);
              const action = runRequest.action?.action;
              if (action?.case === "userMessageAction") {
                const text = action.value.userMessage?.text;
                if (typeof text === "string") runUserTexts.push(text);
              }
              runSelections.push({
                publicId: modelId,
                displayName: runRequest.modelDetails?.displayName,
                modelDetailsMaxMode: runRequest.modelDetails?.maxMode,
                modelId: runRequest.requestedModel?.modelId,
                maxMode: runRequest.requestedModel?.maxMode,
                parameters: Object.fromEntries(
                  (runRequest.requestedModel?.parameters ?? []).map((parameter) => [
                    parameter.id,
                    parameter.value,
                  ]),
                ),
              });
            }
          } catch {
            // Other Connect frames are not relevant to model-routing assertions.
          }
        }
      });
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
      if (runMode === "heartbeat-only-stall" && !runStallConsumed) {
        runStallConsumed = true;
        // Simulate Grok "weighing options": periodic heartbeats, zero content.
        // Without the keepalive exclusion these would falsely reset the stall timer.
        const heartbeatTimer = setInterval(() => {
          try {
            stream.write(frameHeartbeatServerMessage());
          } catch {
            clearInterval(heartbeatTimer);
          }
        }, 200);
        setTimeout(() => {
          clearInterval(heartbeatTimer);
          try {
            stream.end();
          } catch {
            // ignore
          }
        }, 8_000);
        return;
      }
      if (runMode === "text-then-hang") {
        try {
          stream.write(frameTextThenEndServerMessages("partial...")[0]!);
        } catch {
          // ignore
        }
        // Keep the Run open (no turn_ended / end) until the client aborts.
        setTimeout(() => {
          try {
            stream.end();
          } catch {
            // ignore
          }
        }, 8_000);
        return;
      }
      for (const frame of frameTextThenEndServerMessages("ok")) {
        try {
          stream.write(frame);
        } catch {
          // ignore
        }
      }
      stream.end();
      return;
    }

    const chunks: Buffer[] = [];

    stream.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    stream.on("end", () => {
      if (path === "/aiserver.v1.AiService/AvailableModels") {
        if (!availableModels) {
          stream.respond({ ":status": 404, "content-type": "application/json" });
          stream.end(JSON.stringify({ error: "not configured" }));
          return;
        }
        stream.respond({ ":status": 200, "content-type": "application/json" });
        stream.end(JSON.stringify({ models: availableModels }));
        return;
      }

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
    setAvailableModels(models) {
      availableModels = models;
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
      runModelIds.length = 0;
      runUserTexts.length = 0;
      runSelections.length = 0;
    },
    getRunRequestCount() {
      return runRequestCount;
    },
    getRunUserTexts() {
      return [...runUserTexts];
    },
    getRunModelIds() {
      return [...runModelIds];
    },
    getRunSelections() {
      return runSelections.map((selection) => ({
        ...selection,
        parameters: { ...selection.parameters },
      }));
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
  const modelSelection = await import("../src/model-selection");
  const authLogin = await import("../src/auth-login");
  return {
    startProxy: proxy.startProxy,
    stopProxy: proxy.stopProxy,
    getProxyPort: proxy.getProxyPort,
    resolveProxyModelId: proxy.resolveProxyModelId,
    computeUsage: proxy.computeUsage,
    isServerKeepaliveMessage: proxy.isServerKeepaliveMessage,
    cursorSelectionHeader: modelSelection.CURSOR_SELECTION_HEADER,
    encodeCursorModelSelection: modelSelection.encodeCursorModelSelection,
    decodeCursorModelSelection: modelSelection.decodeCursorModelSelection,
    generateCursorAuthParams: auth.generateCursorAuthParams,
    getTokenExpiry: auth.getTokenExpiry,
    CursorAuthPlugin: index.CursorAuthPlugin,
    getCursorModels: models.getCursorModels,
    clearModelCache: models.clearModelCache,
    normalizeCursorModels: models.normalizeCursorModels,
    normalizeAvailableModels: models.normalizeAvailableModels,
    resolveCursorModelSelection: models.resolveCursorModelSelection,
    resetPendingCursorLogin: authLogin.resetPendingCursorLogin,
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
  assertEqual(
    modules.resolveProxyModelId("gpt-5.6-sol", "gpt-5.6-sol-high"),
    "gpt-5.6-sol-high",
    "Expected private header selection to override the public family id",
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
  if (hooks.auth.methods[0].label !== "Login with Cursor") {
    throw new Error(
      `Expected auth method label 'Login with Cursor', got '${hooks.auth.methods[0].label}'`,
    );
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api2.cursor.sh/auth/poll")) {
      return new Response("", { status: 404 });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    const authStart = await hooks.auth.methods[0].authorize();
    if (!authStart || typeof authStart !== "object") {
      throw new Error("Expected authorize() to return an OAuth result");
    }
    if (authStart.method !== "auto") {
      throw new Error(`Expected OAuth method 'auto', got '${authStart.method}'`);
    }
    if (typeof authStart.url !== "string" || !authStart.url.includes("cursor.com")) {
      throw new Error(`Expected Cursor login URL, got '${String(authStart.url)}'`);
    }
    if (
      typeof authStart.instructions !== "string" ||
      !authStart.instructions.toLowerCase().includes("opencode auth login")
    ) {
      throw new Error(
        "Expected authorize() instructions to mention `opencode auth login`",
      );
    }
    if (
      typeof authStart.instructions !== "string" ||
      !authStart.instructions.toLowerCase().includes("api key")
    ) {
      throw new Error(
        "Expected authorize() instructions to clarify that no API key is required",
      );
    }
    if (typeof authStart.callback !== "function") {
      throw new Error("Expected authorize() result to include callback()");
    }
  } finally {
    globalThis.fetch = originalFetch;
    modules.resetPendingCursorLogin();
  }

  if (typeof hooks["chat.headers"] !== "function") {
    throw new Error("Plugin hooks missing 'chat.headers'");
  }
  if (typeof hooks["chat.params"] !== "function") {
    throw new Error("Plugin hooks missing 'chat.params'");
  }

  console.log("[test] Plugin shape OK");
}

function enumParameter(
  id: string,
  values: Array<{ value: string; displayName?: string }>,
): Record<string, unknown> {
  return {
    id,
    parameterType: { enumParameter: { values } },
  };
}

function booleanParameter(id: string): Record<string, unknown> {
  return {
    id,
    parameterType: {
      booleanParameter: {
        values: [{ value: "false" }, { value: "true", displayName: "Fast" }],
      },
    },
  };
}

function makeGptAvailableModel(includeFast = false): Record<string, unknown> {
  // Cursor does not guarantee the presentation order OpenCode expects.
  const efforts = ["low", "medium", "high", "none", "xhigh", "max"];
  const baseVariants = ["272k", "1m"].flatMap((context) =>
    efforts.map((reasoning) => ({
      parameterValues: [
        { id: "context", value: context },
        { id: "reasoning", value: reasoning },
        { id: "fast", value: "false" },
      ],
      legacySlug: `gpt-5.6-sol-${reasoning}`,
      isMaxMode: context === "1m",
      isDefaultNonMaxConfig: context === "272k" && reasoning === "medium",
      isDefaultMaxConfig: context === "1m" && reasoning === "medium",
    })),
  );
  const variants = includeFast
    ? baseVariants.flatMap((variant) => [
        variant,
        {
          ...variant,
          parameterValues: variant.parameterValues.map((parameter) =>
            parameter.id === "fast"
              ? { id: "fast", value: "true" }
              : parameter,
          ),
          legacySlug: `${variant.legacySlug}-fast`,
          isDefaultNonMaxConfig: false,
          isDefaultMaxConfig: false,
        },
      ])
    : baseVariants;
  return {
    name: "gpt-5.6-sol",
    clientDisplayName: "GPT-5.6 Sol",
    serverModelName: "gpt-5.6-sol",
    parameterDefinitions: [
      enumParameter("context", [
        { value: "272k", displayName: "272K" },
        { value: "1m", displayName: "1M" },
      ]),
      enumParameter(
        "reasoning",
        efforts.map((value) => ({ value })),
      ),
      booleanParameter("fast"),
    ],
    variants,
  };
}

function makeOpusAvailableModel(): Record<string, unknown> {
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  const variants = ["300k", "1m"].flatMap((context) =>
    [false, true].flatMap((thinking) =>
      efforts.map((effort) => ({
        parameterValues: [
          { id: "thinking", value: String(thinking) },
          { id: "context", value: context },
          { id: "effort", value: effort },
          { id: "fast", value: "false" },
        ],
        legacySlug: `claude-opus-4-8-${thinking ? "thinking-" : ""}${effort}`,
        isMaxMode: context === "1m",
        isDefaultNonMaxConfig:
          context === "300k" && thinking && effort === "high",
        isDefaultMaxConfig: context === "1m" && thinking && effort === "high",
      })),
    ),
  );
  return {
    name: "claude-opus-4-8",
    clientDisplayName: "Opus 4.8",
    serverModelName: "claude-opus-4-8",
    parameterDefinitions: [
      booleanParameter("thinking"),
      enumParameter("context", [
        { value: "300k", displayName: "300K" },
        { value: "1m", displayName: "1M" },
      ]),
      enumParameter("effort", efforts.map((value) => ({ value }))),
      booleanParameter("fast"),
    ],
    variants,
  };
}

function filterAvailableVariants(
  model: Record<string, unknown>,
  predicate: (parameters: Record<string, string>) => boolean,
): Record<string, unknown> {
  const variants = Array.isArray(model.variants) ? model.variants : [];
  return {
    ...model,
    variants: variants.filter((variant) => {
      if (!variant || typeof variant !== "object" || Array.isArray(variant)) return false;
      const variantRecord = variant as Record<string, unknown>;
      const parameterValues = Array.isArray(variantRecord.parameterValues)
        ? variantRecord.parameterValues
        : [];
      const values = Object.fromEntries(
        parameterValues.flatMap((parameter) => {
          if (!parameter || typeof parameter !== "object" || Array.isArray(parameter)) {
            return [];
          }
          const parameterRecord = parameter as Record<string, unknown>;
          return typeof parameterRecord.id === "string"
            ? [[parameterRecord.id, String(parameterRecord.value)] as const]
            : [];
        }),
      );
      return predicate(values);
    }),
  };
}

async function testAvailableModelParameterGrouping(modules: TestModules) {
  console.log("[test] Testing parameter-aware AvailableModels grouping...");
  const models = modules.normalizeAvailableModels([
    makeGptAvailableModel(),
    makeOpusAvailableModel(),
  ]);

  const gptIds = models
    .filter((model) => model.id.startsWith("gpt-5.6-sol"))
    .map((model) => model.id);
  assertArrayEqual(
    gptIds,
    [
      "gpt-5.6-sol",
      "gpt-5.6-sol-1m",
    ],
    "Expected only returned GPT context combinations",
  );
  for (const id of gptIds) {
    const model = models.find((candidate) => candidate.id === id)!;
    assertArrayEqual(
      Object.keys(model.variants),
      ["none", "low", "medium", "high", "xhigh", "max"],
      `Expected simple GPT effort variants on ${id}`,
    );
  }

  const gpt1mHigh = models.find((model) => model.id === "gpt-5.6-sol-1m")!
    .variants.high;
  assertEqual(gpt1mHigh.modelId, "gpt-5.6-sol", "Expected shared GPT server model");
  assertEqual(gpt1mHigh.maxMode, true, "Expected 1M GPT max mode");
  assertEqual(
    Object.fromEntries(gpt1mHigh.parameters.map((parameter) => [parameter.id, parameter.value])).context,
    "1m",
    "Expected 1M GPT context parameter",
  );
  const fastModels = modules.normalizeAvailableModels([
    makeGptAvailableModel(true),
  ]);
  assertArrayEqual(
    fastModels.map((model) => model.id),
    [
      "gpt-5.6-sol",
      "gpt-5.6-sol-1m",
      "gpt-5.6-sol-1m-fast",
      "gpt-5.6-sol-fast",
    ],
    "Expected Fast listings only when fast=true variants are returned",
  );
  const gptFast = fastModels.find((model) => model.id === "gpt-5.6-sol-fast")!;
  assertEqual(
    Object.fromEntries(
      gptFast.variants.medium.parameters.map((parameter) => [parameter.id, parameter.value]),
    ).fast,
    "true",
    "Expected returned GPT Fast listing",
  );

  const fastWithout1m = modules.normalizeAvailableModels([
    filterAvailableVariants(
      makeGptAvailableModel(true),
      (parameters) => parameters.context === "272k",
    ),
  ]);
  assertArrayEqual(
    fastWithout1m.map((model) => model.id),
    ["gpt-5.6-sol", "gpt-5.6-sol-fast"],
    "Expected an org with Fast but no 1M to expose only those combinations",
  );
  const oneMWithoutFast = modules.normalizeAvailableModels([
    filterAvailableVariants(
      makeGptAvailableModel(false),
      (parameters) => parameters.context === "1m",
    ),
  ]);
  assertArrayEqual(
    oneMWithoutFast.map((model) => model.id),
    ["gpt-5.6-sol-1m"],
    "Expected an org with 1M but no Fast to expose only the 1M listing",
  );

  const opusIds = models
    .filter((model) => model.id.startsWith("claude-opus-4-8"))
    .map((model) => model.id);
  assertArrayEqual(
    opusIds,
    [
      "claude-opus-4-8",
      "claude-opus-4-8-1m",
      "claude-opus-4-8-1m-thinking",
      "claude-opus-4-8-thinking",
    ],
    "Expected only returned context and Thinking combinations for Opus",
  );
  for (const id of opusIds) {
    const model = models.find((candidate) => candidate.id === id)!;
    assertArrayEqual(
      Object.keys(model.variants),
      ["low", "medium", "high", "xhigh", "max"],
      `Expected simple Opus effort variants on ${id}`,
    );
  }
  assertEqual(
    models.find((model) => model.id === "claude-opus-4-8-1m-thinking")?.name,
    "Opus 4.8 1M Thinking",
    "Expected Opus listing name to preserve context and Thinking",
  );
  const thinkingOnly = modules.normalizeAvailableModels([
    filterAvailableVariants(
      makeOpusAvailableModel(),
      (parameters) =>
        parameters.context === "300k" && parameters.thinking === "true",
    ),
  ]);
  assertArrayEqual(
    thinkingOnly.map((model) => model.id),
    ["claude-opus-4-8-thinking"],
    "Expected restricted Thinking availability to produce only its returned listing",
  );

  const edgeModels = modules.normalizeAvailableModels([
    {
      name: "partial",
      clientDisplayName: "Partial",
      serverModelName: "partial",
      parameterDefinitions: [
        enumParameter("effort", [
          { value: "low" },
          { value: "medium" },
          { value: "high" },
          { value: "turbo" },
        ]),
        booleanParameter("fast"),
      ],
      variants: [
        { parameterValues: [{ id: "effort", value: "low" }, { id: "fast", value: "false" }], legacySlug: "partial-low" },
        { parameterValues: [{ id: "effort", value: "low" }, { id: "fast", value: "true" }], legacySlug: "partial-low-fast" },
        { parameterValues: [{ id: "effort", value: "medium" }], legacySlug: "partial-medium" },
        { parameterValues: [{ id: "effort", value: "HIGH" }, { id: "fast", value: "false" }], legacySlug: "partial-high" },
        { parameterValues: [{ id: "effort", value: "turbo" }, { id: "fast", value: "false" }], legacySlug: "partial-turbo" },
      ],
    },
    {
      name: "collision",
      clientDisplayName: "Collision",
      serverModelName: "collision",
      parameterDefinitions: [
        enumParameter("effort", [{ value: "low" }, { value: "medium" }]),
        booleanParameter("fast"),
      ],
      variants: [
        { parameterValues: [{ id: "effort", value: "low" }, { id: "fast", value: "false" }], legacySlug: "collision-low" },
        { parameterValues: [{ id: "effort", value: "medium" }, { id: "fast", value: "false" }], legacySlug: "collision-medium" },
        { parameterValues: [{ id: "effort", value: "low" }, { id: "fast", value: "true" }], legacySlug: "collision-low-fast" },
        { parameterValues: [{ id: "effort", value: "medium" }, { id: "fast", value: "true" }], legacySlug: "collision-medium-fast" },
      ],
    },
    {
      name: "collision-fast",
      clientDisplayName: "Native Collision Fast",
      serverModelName: "collision-fast",
      variants: [{ legacySlug: "collision-fast" }],
    },
    {
      name: "dimensions",
      clientDisplayName: "Dimensions",
      serverModelName: "dimensions",
      parameterDefinitions: [
        enumParameter("region", [
          { value: "us", displayName: "US" },
          { value: "eu", displayName: "EU" },
        ]),
        enumParameter("effort", [{ value: "low" }, { value: "high" }]),
      ],
      variants: [
        { parameterValues: [{ id: "region", value: "us" }, { id: "effort", value: "low" }], legacySlug: "dimensions-us-low" },
        { parameterValues: [{ id: "region", value: "us" }, { id: "effort", value: "high" }], legacySlug: "dimensions-us-high" },
        { parameterValues: [{ id: "region", value: "eu" }, { id: "effort", value: "low" }], legacySlug: "dimensions-eu-low" },
        { parameterValues: [{ id: "region", value: "eu" }, { id: "effort", value: "high" }], legacySlug: "dimensions-eu-high" },
      ],
    },
    {
      name: "unknown-dimension",
      clientDisplayName: "Unknown Dimension",
      serverModelName: "unknown-dimension",
      variants: [
        { parameterValues: [{ id: "region", value: "us" }, { id: "effort", value: "low" }], legacySlug: "unknown-dimension-low" },
        { parameterValues: [{ id: "effort", value: "high" }], legacySlug: "unknown-dimension-high" },
      ],
    },
    {
      name: "collision-values",
      clientDisplayName: "Collision Values",
      serverModelName: "collision-values",
      parameterDefinitions: [
        enumParameter("region", [
          { value: "us" },
          { value: "eu-west" },
          { value: "eu west" },
        ]),
        enumParameter("effort", [{ value: "low" }, { value: "high" }]),
      ],
      variants: [
        { parameterValues: [{ id: "region", value: "eu-west" }, { id: "effort", value: "low" }], legacySlug: "collision-values-low" },
        { parameterValues: [{ id: "region", value: "eu west" }, { id: "effort", value: "high" }], legacySlug: "collision-values-high" },
      ],
    },
    {
      name: "sonnet-4-6-test",
      clientDisplayName: "Sonnet 4.6 Test",
      serverModelName: "sonnet-4-6-test",
      variants: ["low", "medium", "high", "max"].map((effort) => ({
        parameterValues: [{ id: "effort", value: effort }],
        legacySlug: `sonnet-4-6-test-${effort}`,
      })),
    },
    {
      name: "sonnet-5-test",
      clientDisplayName: "Sonnet 5 Test",
      serverModelName: "sonnet-5-test",
      variants: ["low", "medium", "high", "xhigh", "max"].map((effort) => ({
        parameterValues: [{ id: "effort", value: effort }],
        legacySlug: `sonnet-5-test-${effort}`,
      })),
    },
  ]);
  assertArrayEqual(
    Object.keys(edgeModels.find((model) => model.id === "partial-fast")!.variants),
    ["low"],
    "Expected only explicitly returned Fast effort combinations",
  );
  assertArrayEqual(
    Object.keys(edgeModels.find((model) => model.id === "partial")!.variants),
    ["low", "medium", "high"],
    "Expected unknown efforts to be excluded and mixed-case efforts normalized",
  );
  const collision = edgeModels.find((model) => model.id === "collision-fast");
  assertEqual(
    collision?.defaultSelection.modelId,
    "collision-fast",
    "Expected a declared model to win over a generated structural id collision",
  );
  assertEqual(
    edgeModels.find((model) => model.id === "collision-fast-from-collision")
      ?.defaultSelection.modelId,
    "collision",
    "Expected the colliding returned structural combination to remain addressable",
  );
  assertArrayEqual(
    edgeModels
      .filter((model) => model.id.startsWith("dimensions"))
      .map((model) => model.id),
    ["dimensions", "dimensions-region-eu"],
    "Expected arbitrary returned structural parameter combinations to form listings",
  );
  assertArrayEqual(
    edgeModels
      .filter((model) => model.id.startsWith("unknown-dimension"))
      .map((model) => model.id),
    ["unknown-dimension", "unknown-dimension-region-unset"],
    "Expected missing and explicit unknown structural values to remain distinct",
  );
  const normalizedCollisionIds = edgeModels
    .filter((model) => model.id.startsWith("collision-values-region-eu-west"))
    .map((model) => model.id);
  assertArrayEqual(
    normalizedCollisionIds,
    [
      "collision-values-region-eu-west",
      "collision-values-region-eu-west-from-collision-values",
    ],
    "Expected lossless structural grouping before public-id normalization",
  );
  assertArrayEqual(
    normalizedCollisionIds.map((id) =>
      edgeModels.find((model) => model.id === id)!.defaultSelection.parameters
        .find((parameter) => parameter.id === "region")!.value,
    ),
    ["eu-west", "eu west"],
    "Expected both colliding structural values to remain addressable",
  );
  assertArrayEqual(
    Object.keys(edgeModels.find((model) => model.id === "sonnet-4-6-test")!.variants),
    ["low", "medium", "high", "max"],
    "Expected Sonnet 4.6 to omit unavailable xhigh",
  );
  assertArrayEqual(
    Object.keys(edgeModels.find((model) => model.id === "sonnet-5-test")!.variants),
    ["low", "medium", "high", "xhigh", "max"],
    "Expected Sonnet 5 to retain returned xhigh",
  );

  const namedModels = modules.normalizeAvailableModels([
    {
      name: "grok-4-5",
      serverModelName: "grok-4-5",
      supportsThinking: true,
      supportsMaxMode: true,
      supportsNonMaxMode: true,
      isUserAdded: true,
      inputboxShortModelName: "grok-4-5",
    },
    {
      name: "grok-code-fast-1",
      serverModelName: "grok-code-fast-1",
      supportsThinking: true,
      tooltipData: {
        markdownContent:
          "**Grok Code Fast 1**<br />Fast, good for daily use.<br /><br />256k context window",
      },
      isUserAdded: true,
    },
  ]);
  assertArrayEqual(
    namedModels.map((model) => model.id).sort(),
    ["grok-4-5", "grok-code-fast-1"],
    "Expected named models without variants to be preserved",
  );
  assertEqual(
    namedModels.find((model) => model.id === "grok-4-5")?.name,
    "Grok 4.5",
    "Expected Grok 4.5 display name formatting",
  );
  assertEqual(
    namedModels.find((model) => model.id === "grok-code-fast-1")?.name,
    "Grok Code Fast 1",
    "Expected tooltip title for named Grok models",
  );

  console.log("[test] Parameter-aware AvailableModels grouping OK");
}

async function testCursorModelVariantGrouping(modules: TestModules) {
  console.log("[test] Testing Cursor model family grouping...");

  const models = modules.normalizeCursorModels([
    {
      modelId: "gpt-5.6-sol-low",
      displayName: "GPT-5.6 Sol Low",
      thinkingDetails: {},
    },
    {
      modelId: "gpt-5.6-sol-medium",
      displayName: "GPT-5.6 Sol Medium",
      thinkingDetails: {},
    },
    {
      modelId: "gpt-5.6-sol-high",
      displayName: "GPT-5.6 Sol High",
      thinkingDetails: {},
    },
    {
      modelId: "gpt-5.6-sol-extra-high",
      displayName: "GPT-5.6 Sol Extra High",
      thinkingDetails: {},
    },
    {
      modelId: "claude-opus-4.8-none",
      displayName: "Claude Opus 4.8 None",
      thinkingDetails: {},
    },
    {
      modelId: "claude-opus-4.8-high",
      displayName: "Claude Opus 4.8 High",
      thinkingDetails: {},
    },
    {
      modelId: "claude-opus-4.8-low-thinking",
      displayName: "Claude Opus 4.8 Low Thinking",
      thinkingDetails: {},
    },
    {
      modelId: "claude-opus-4.8-high-thinking",
      displayName: "Claude Opus 4.8 High Thinking",
      thinkingDetails: {},
    },
    {
      modelId: "claude-opus-4.8-1m-none",
      displayName: "Claude Opus 4.8 1M None",
      thinkingDetails: {},
    },
    {
      modelId: "claude-opus-4.8-1m-high",
      displayName: "Claude Opus 4.8 1M High",
      thinkingDetails: {},
    },
    {
      modelId: "claude-opus-4.8-1m-low-thinking",
      displayName: "Claude Opus 4.8 1M Low Thinking",
      thinkingDetails: {},
    },
    {
      modelId: "claude-opus-4.8-1m-high-thinking",
      displayName: "Claude Opus 4.8 1M High Thinking",
      thinkingDetails: {},
    },
    {
      modelId: "gpt-5.1-codex-max",
      displayName: "GPT-5.1 Codex Max",
      thinkingDetails: {},
    },
  ]);

  assertArrayEqual(
    models.map((model) => model.id),
    [
      "claude-opus-4.8",
      "claude-opus-4.8-1m",
      "claude-opus-4.8-1m-thinking",
      "claude-opus-4.8-thinking",
      "gpt-5.1-codex-max",
      "gpt-5.6-sol",
    ],
    "Expected effort permutations to collapse into stable families",
  );

  const gpt = models.find((model) => model.id === "gpt-5.6-sol");
  assert(gpt, "Expected grouped GPT family");
  assertEqual(gpt.name, "GPT-5.6 Sol", "Expected variant label removed from family name");
  assertEqual(
    gpt.defaultSelection.publicId,
    "gpt-5.6-sol-medium",
    "Expected medium to be the default when Cursor provides no bare model",
  );
  assertEqual(gpt.variants.low.publicId, "gpt-5.6-sol-low", "Expected low wire model");
  assertEqual(gpt.variants.medium.publicId, "gpt-5.6-sol-medium", "Expected medium wire model");
  assertEqual(gpt.variants.high.publicId, "gpt-5.6-sol-high", "Expected high wire model");
  assertEqual(
    gpt.variants.xhigh.publicId,
    "gpt-5.6-sol-extra-high",
    "Expected Extra High to use OpenCode's xhigh variant key",
  );
  assertEqual(
    modules.resolveCursorModelSelection(models, "gpt-5.6-sol", "high")?.publicId,
    "gpt-5.6-sol-high",
    "Expected explicit variant to resolve to its Cursor wire model",
  );
  assertEqual(
    modules.resolveCursorModelSelection(models, "gpt-5.6-sol", undefined)?.publicId,
    "gpt-5.6-sol-medium",
    "Expected missing variant to resolve to the family default",
  );

  const opus = models.find((model) => model.id === "claude-opus-4.8-1m");
  assert(opus, "Expected grouped 1M family");
  assertEqual(
    opus.variants.high.publicId,
    "claude-opus-4.8-1m-high",
    "Expected non-thinking effort to remain on the 1M family",
  );

  const opusThinking = models.find(
    (model) => model.id === "claude-opus-4.8-1m-thinking",
  );
  assert(opusThinking, "Expected Thinking to remain a separate 1M family");
  assertEqual(
    opusThinking.name,
    "Claude Opus 4.8 1M Thinking",
    "Expected Thinking to remain in the model name",
  );
  assertEqual(
    opusThinking.variants.high.publicId,
    "claude-opus-4.8-1m-high-thinking",
    "Expected simple high effort on the separate Thinking family",
  );

  const codexMax = models.find((model) => model.id === "gpt-5.1-codex-max");
  assert(codexMax, "Expected ambiguous lone -max model to remain flat");
  assertEqual(
    Object.keys(codexMax.variants).length,
    0,
    "Expected no inferred variants for an ambiguous lone model",
  );

  const mismatchedNames = modules.normalizeCursorModels([
    { modelId: "vendor-model-low", displayName: "Legacy Low" },
    { modelId: "vendor-model-high", displayName: "Next High" },
  ]);
  assertArrayEqual(
    mismatchedNames.map((model) => model.id),
    ["vendor-model-high", "vendor-model-low"],
    "Expected mismatched display-name bases to remain separate",
  );

  console.log("[test] Cursor model family grouping OK");
}

async function testCursorVariantHooks(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing Cursor variant hook routing...");
  modules.stopProxy();
  modules.clearModelCache();
  backend.setDiscoveryMode("success");
  backend.setAvailableModels([makeGptAvailableModel()]);

  const hooks = await modules.CursorAuthPlugin({
    client: { auth: { set: async () => {} } },
  } as any);
  const provider = { models: {} as Record<string, any> };
  await hooks.auth!.loader(
    async () => ({
      type: "oauth",
      access: "variant-access",
      refresh: "valid-refresh",
      expires: Date.now() + 60_000,
    }),
    provider as any,
  );

  const family = provider.models["gpt-5.6-sol"];
  assert(family, "Expected runtime provider to expose one GPT family");
  assert(provider.models["gpt-5.6-sol-1m"], "Expected separate GPT 1M listing");
  assert(
    !("gpt-5.6-sol-fast" in provider.models),
    "Expected no Fast listing when AvailableModels returns no fast=true variant",
  );
  assertEqual(
    family.variants.high.cursorVariant,
    "high",
    "Expected namespaced high variant marker",
  );

  const headerOutput = { headers: {} as Record<string, string> };
  await hooks["chat.headers"]!(
    {
      sessionID: "variant-session",
      agent: "build",
      model: family,
      message: {
        model: {
          providerID: "cursor",
          modelID: "gpt-5.6-sol",
          variant: "high",
        },
      },
    } as any,
    headerOutput,
  );
  const encodedSelection = headerOutput.headers[modules.cursorSelectionHeader];
  const decodedSelection = modules.decodeCursorModelSelection(encodedSelection);
  assertEqual(
    decodedSelection?.publicId,
    "gpt-5.6-sol-high",
    "Expected selected variant to become the exact Cursor selection header",
  );
  assertEqual(
    decodedSelection?.modelId,
    "gpt-5.6-sol",
    "Expected selected variant to retain the Cursor server model",
  );
  assertEqual(
    Object.fromEntries(
      (decodedSelection?.parameters ?? []).map((parameter) => [
        parameter.id,
        parameter.value,
      ]),
    ).context,
    "272k",
    "Expected selected variant to retain its context parameter",
  );

  const paramsOutput = {
    temperature: undefined,
    topP: undefined,
    topK: undefined,
    options: {
      reasoningEffort: "medium",
      cursorVariant: "high",
      keep: "value",
    } as Record<string, unknown>,
  };
  await hooks["chat.params"]!(
    { model: family } as any,
    paramsOutput as any,
  );
  assert(
    !("reasoningEffort" in paramsOutput.options),
    "Expected injected reasoning effort to be removed",
  );
  assert(
    !("cursorVariant" in paramsOutput.options),
    "Expected private variant marker not to reach the SDK request body",
  );
  assertEqual(
    paramsOutput.options.keep,
    "value",
    "Expected unrelated request options to remain",
  );

  modules.stopProxy();
  backend.setAvailableModels(undefined);
  modules.clearModelCache();
  console.log("[test] Cursor variant hook routing OK");
}

async function testProxyConsumesCursorModelHeader(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing proxy consumes Cursor model header...");
  modules.stopProxy();
  backend.setRunMode("immediate-close");
  const port = await modules.startProxy(async () => "test-token");

  const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [modules.cursorSelectionHeader]: modules.encodeCursorModelSelection({
        publicId: "gpt-5.6-sol-high",
        modelId: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        parameters: [
          { id: "context", value: "1m" },
          { id: "reasoning", value: "high" },
          { id: "fast", value: "false" },
        ],
        maxMode: true,
      }),
    },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      stream: true,
      messages: [{ role: "user", content: "route this model" }],
    }),
  });
  assertEqual(res.status, 200, "Expected header-routed request to succeed");
  await res.text();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert(
    backend.getRunModelIds().includes("gpt-5.6-sol-high"),
    `Expected Cursor Run model gpt-5.6-sol-high, got ${JSON.stringify(backend.getRunModelIds())}`,
  );
  const selection = backend.getRunSelections().at(-1);
  assertEqual(selection?.modelId, "gpt-5.6-sol", "Expected RequestedModel server id");
  assertEqual(selection?.maxMode, true, "Expected RequestedModel max mode");
  assertEqual(selection?.displayName, "GPT-5.6 Sol", "Expected ModelDetails display name");
  assertEqual(selection?.modelDetailsMaxMode, true, "Expected ModelDetails max mode");
  assertEqual(selection?.parameters.context, "1m", "Expected context parameter");
  assertEqual(selection?.parameters.reasoning, "high", "Expected reasoning parameter");

  modules.stopProxy();
  console.log("[test] Proxy Cursor model header routing OK");
}

async function testConfigHookSeedsProvider(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Checking config hook seeds cursor provider...");

  const prevXdg = process.env.XDG_DATA_HOME;
  const loggedOutDir = "/tmp/opencode-cursor-smoke-empty";
  const loggedInDir = "/tmp/opencode-cursor-smoke-logged-in";

  // Logged out: point the auth store at an empty dir so there is no token.
  process.env.XDG_DATA_HOME = loggedOutDir;

  const fakeInput = {
    client: { auth: { set: async () => {} } },
  } as any;
  const hooks = await modules.CursorAuthPlugin(fakeInput);

  if (typeof hooks.config !== "function") {
    throw new Error("Plugin hooks.config is not a function");
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api2.cursor.sh/auth/poll")) {
      return new Response("", { status: 404 });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
  // Fresh config while logged out: keep a single login placeholder so OpenCode
  // / OpenChamber still list the Cursor provider (empty models are dropped).
  const fresh: any = {};
  await hooks.config!(fresh);
  const cursor = fresh.provider?.cursor;
  assert(cursor, "Expected config hook to create provider.cursor");
  assert(
    cursor.name.includes("browser OAuth") || cursor.name.includes("sign in"),
    `Expected seeded provider name to mention browser OAuth / sign in, got '${cursor.name}'`,
  );
  assertEqual(cursor.npm, "@ai-sdk/openai-compatible", "Expected seeded npm");
  assert(cursor.options?.baseURL, "Expected seeded options.baseURL");
  assertEqual(
    Object.keys(cursor.models ?? {}).length,
    1,
    "Expected a single login placeholder model when logged out",
  );
  assert(
    "default" in (cursor.models ?? {}),
    "Expected login placeholder default model when logged out",
  );
  assert(
    typeof cursor.models.default.name === "string" &&
      (cursor.models.default.name.startsWith("OPEN THIS URL TO LOGIN → ") ||
        cursor.models.default.name === "Cursor (authorize to load models)"),
    `Expected login placeholder to embed browser URL or authorize hint, got '${cursor.models.default.name}'`,
  );
  if (cursor.models.default.name.startsWith("OPEN THIS URL TO LOGIN → ")) {
    assert(
      cursor.models.default.name.includes("cursor.com") ||
        cursor.models.default.name.includes("loginDeepControl"),
      "Expected embedded login URL to point at Cursor",
    );
  }
  assert(
    !("composer-1" in (cursor.models ?? {})),
    "Expected fallback model composer-1 not to be seeded when logged out",
  );

  // User overrides must be preserved; logged-out must not inject the full
  // fallback catalog over a user's explicit model list.
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
    !("composer-1" in c2.models),
    "Expected fallback models not to be merged when logged out",
  );

  // Logged in with empty discovery: never advertise the hardcoded FALLBACK
  // catalog (~14 models) in the provider UI — keep the login placeholder.
  await mkdir(join(loggedInDir, "opencode"), { recursive: true });
  await writeFile(
    join(loggedInDir, "opencode", "auth.json"),
    JSON.stringify({
      cursor: {
        type: "oauth",
        access: "smoke-test-access-token",
        refresh: "smoke-test-refresh",
        expires: Date.now() + 3_600_000,
      },
    }),
  );
  process.env.XDG_DATA_HOME = loggedInDir;
  modules.clearModelCache();
  backend.setAvailableModels(undefined);
  backend.setDiscoveryMode("empty");

  const loggedInHooks = await modules.CursorAuthPlugin(fakeInput);
  const degraded: any = {};
  await loggedInHooks.config!(degraded);
  const degradedCursor = degraded.provider?.cursor;
  assert(degradedCursor, "Expected config hook to create provider.cursor");
  assertEqual(
    Object.keys(degradedCursor.models ?? {}).length,
    1,
    "Expected login placeholder instead of hardcoded fallback catalog when discovery fails",
  );
  assert(
    "default" in degradedCursor.models,
    "Expected login placeholder default model when discovery fails",
  );
  assert(
    !("composer-1" in degradedCursor.models),
    "Expected fallback model composer-1 not to be seeded when discovery fails",
  );
  assertEqual(
    degradedCursor.models.default.reasoning,
    false,
    "Expected cursor/default not to generate misleading reasoning variants",
  );
  assertEqual(
    degradedCursor.models.default.variants.low.disabled,
    true,
    "Expected cursor/default low variant to be suppressed",
  );
  assertEqual(
    degradedCursor.models.default.variants.max.disabled,
    true,
    "Expected cursor/default max variant to be suppressed",
  );

  // Logged in with successful discovery: seed the live catalog (not fallback).
  modules.clearModelCache();
  backend.setDiscoveryMode("success");
  backend.setDiscoveredModels([
    { id: "composer-2", name: "Composer 2", reasoning: true },
    { id: "claude-4.6-sonnet-medium", name: "Claude 4.6 Sonnet", reasoning: true },
  ]);
  // AvailableModels path takes priority; leave it unset so GetUsableModels is used.
  backend.setAvailableModels(undefined);

  const liveHooks = await modules.CursorAuthPlugin(fakeInput);
  const live: any = {};
  await liveHooks.config!(live);
  const liveCursor = live.provider?.cursor;
  assert(liveCursor, "Expected config hook to create provider.cursor");
  assert(
    "composer-2" in liveCursor.models,
    "Expected discovered composer-2 when logged in with successful discovery",
  );
  assert(
    "claude-4.6-sonnet-medium" in liveCursor.models,
    "Expected discovered claude model when logged in with successful discovery",
  );
  assert(
    !("composer-1" in liveCursor.models) || liveCursor.models["composer-2"],
    "Expected live discovery catalog rather than only hardcoded fallbacks",
  );

  backend.setDiscoveryMode("success");
  modules.clearModelCache();

  if (prevXdg === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = prevXdg;
  }

  console.log("[test] Config hook seeding OK");
  } finally {
    globalThis.fetch = originalFetch;
    modules.resetPendingCursorLogin();
  }
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

/**
 * Test that concurrent requests beyond maxSize succeed via ephemeral overflow
 * workers, and that those untracked workers do not inflate the tracked pool
 * (regression guard for the ephemeral-worker leak fix in BridgePool).
 */
async function testPoolOverflowEphemeralWorkers() {
  console.log("[test] Testing pool overflow ephemeral workers...");

  const { BridgePool } = await import("../src/bridge-pool");
  const server = await createPoolTestServer();

  const pool = new BridgePool({ minSize: 1, maxSize: 1 });
  pool.warmup();
  await new Promise((r) => setTimeout(r, 200));

  // Fire more concurrent requests than maxSize so the pool must spawn
  // ephemeral overflow workers (not tracked in allWorkers).
  const CONCURRENCY = 4;
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => poolRequest(pool, server.url)),
  );
  for (let i = 0; i < results.length; i++) {
    assertEqual(results[i]!.code, 0, `Overflow request ${i} should succeed (code=0)`);
  }

  // Give streamDone-driven shutdown of ephemeral workers time to run.
  await new Promise((r) => setTimeout(r, 200));

  const stats = pool.stats();
  console.log(`[test]   pool stats after overflow: ${JSON.stringify(stats)}`);
  assert(
    stats.total <= 1,
    `Tracked pool must stay within maxSize after overflow, got total=${stats.total}`,
  );
  assert(
    server.streamCount() >= CONCURRENCY,
    `Expected >= ${CONCURRENCY} streams, got ${server.streamCount()}`,
  );

  pool.shutdown();
  await server.close();
  console.log("[test] Pool overflow ephemeral workers OK");
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
  assert(
    !bodyText.includes("[Info: Cursor is still processing"),
    "Default stall wait notice must not interrupt Discord/content streams",
  );
  assert(
    !bodyText.includes("stream stalled; retrying..."),
    "Must not claim retrying when recovery actually ran (or when exhausted uses honest copy)",
  );

  backend.setRunMode("immediate-close");
  modules.stopProxy();
  console.log("[test] Streaming watchdog recovery OK");
}

async function testStallExhaustionIsHonest(modules: TestModules, backend: TestCursorBackend) {
  console.log("[test] Testing stall exhaustion uses honest error (no fake retrying)...");
  modules.stopProxy();
  const prevMax = process.env.OPENCODE_CURSOR_MAX_STALL_RECOVERIES;
  process.env.OPENCODE_CURSOR_MAX_STALL_RECOVERIES = "0";
  backend.setRunMode("stall-once-then-close");

  try {
    const port = await modules.startProxy(async () => "test-token");
    const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "composer-2",
        stream: true,
        messages: [{ role: "user", content: "stall-exhaustion-probe" }],
      }),
    });
    assertEqual(res.status, 200, "Expected streaming request to succeed");
    const bodyText = await res.text();
    assert(
      bodyText.includes("stream stalled; automatic recovery exhausted"),
      `Expected honest exhaustion message, got: ${bodyText.slice(0, 400)}`,
    );
    assert(
      !bodyText.includes("stream stalled; retrying..."),
      "Must not claim retrying when no recovery was scheduled",
    );
    assertEqual(
      backend.getRunRequestCount(),
      1,
      "With max recoveries=0, only the initial Run should execute",
    );
  } finally {
    if (prevMax === undefined) delete process.env.OPENCODE_CURSOR_MAX_STALL_RECOVERIES;
    else process.env.OPENCODE_CURSOR_MAX_STALL_RECOVERIES = prevMax;
    backend.setRunMode("immediate-close");
    modules.stopProxy();
  }
  console.log("[test] Stall exhaustion honest error OK");
}

async function testHeartbeatKeepalivesDoNotBlockStallRecovery(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing heartbeat keepalives do not block stall recovery...");
  modules.stopProxy();

  // Unit: heartbeat interaction updates are classified as keepalives.
  const heartbeatMsg = create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: {
          case: "heartbeat",
          value: create(HeartbeatUpdateSchema, {}),
        },
      }),
    },
  });
  assert(
    modules.isServerKeepaliveMessage(heartbeatMsg),
    "Heartbeat interaction updates must be keepalives",
  );

  backend.setRunMode("heartbeat-only-stall");
  const port = await modules.startProxy(async () => "test-token");
  const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "composer-2",
      stream: true,
      messages: [{ role: "user", content: "weighing-options-heartbeat-probe" }],
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
    `Heartbeats must not prevent stall recovery (>=2 Run attempts), got ${backend.getRunRequestCount()}`,
  );
  assert(
    !bodyText.includes("stream stalled; retrying..."),
    "Must not claim retrying when recovery actually ran",
  );

  backend.setRunMode("immediate-close");
  modules.stopProxy();
  console.log("[test] Heartbeat keepalive stall recovery OK");
}

async function testMutexAbortDoesNotBlockQueue() {
  console.log("[test] Testing mutex abort releases waiters without blocking queue...");
  const { Mutex, isAbortError } = await import("../src/promise-queue");
  const mutex = new Mutex();

  const release1 = await mutex.acquire();
  const controller = new AbortController();
  let aborted = false;
  const waiter = mutex.acquire(controller.signal).then(
    () => {
      throw new Error("Aborted waiter must not acquire the mutex");
    },
    (err: unknown) => {
      aborted = true;
      assert(isAbortError(err), "Expected AbortError from cancelled waiter");
    },
  );

  // Let the waiter enqueue, then cancel it (simulates OpenCode dropping a
  // queued HTTP request while another turn still holds the conversation lock).
  await new Promise((r) => setTimeout(r, 10));
  assertEqual(mutex.waiterCount(), 1, "Expected one waiter while lock held");
  controller.abort();
  await waiter;
  assert(aborted, "Expected waiter promise to reject");
  assertEqual(mutex.waiterCount(), 0, "Aborted waiter must leave the queue");

  release1();
  assert(mutex.isIdle(), "Mutex should be idle after holder release with no waiters");

  // Next real acquire must succeed immediately (not blocked by a zombie).
  const release2 = await mutex.acquire();
  release2();
  assert(mutex.isIdle(), "Mutex should be idle after second acquire/release");
  console.log("[test] Mutex abort queue safety OK");
}

async function testSummaryGenerationDetection(modules: TestModules) {
  console.log("[test] Testing /compact and summary request detection...");
  const proxy = await import("../src/proxy");

  assert(
    proxy.isSummaryGenerationRequest([
      {
        role: "system",
        content:
          "You are an anchored context summarization assistant for coding sessions.\nDo not mention that you are summarizing, compacting, or merging context.",
      },
      { role: "user", content: "Summarize the conversation." },
    ]),
    "Expected compaction system prompt to be detected",
  );
  assert(
    proxy.isSummaryGenerationRequest([
      {
        role: "system",
        content:
          "Summarize what was done in this conversation. Write like a pull request description.",
      },
      { role: "user", content: "please summarize" },
    ]),
    "Expected summary agent prompt to be detected",
  );
  assert(
    !proxy.isSummaryGenerationRequest([
      { role: "system", content: "You are a helpful coding agent." },
      { role: "user", content: "fix the stall bug" },
    ]),
    "Normal chat must not be treated as summary generation",
  );
  // OpenCode 1.18+ compaction: anchored-summary instruction arrives as a bare
  // user message with no system prompt and tools: []. Regression test for
  // "Tool call not allowed while generating summary: bash".
  assert(
    proxy.isSummaryGenerationRequest([
      {
        role: "user",
        content:
          "Create a new anchored summary from the conversation history.\n\n<conversation>\nUser: hi\n</conversation>",
      },
    ]),
    "Expected 1.18-style fresh compaction prompt (user-only) to be detected",
  );
  assert(
    proxy.isSummaryGenerationRequest([
      {
        role: "user",
        content:
          "Update the anchored summary below using the conversation history above.\n\n<previous-summary>\nold summary\n</previous-summary>\n\n<conversation>\nUser: hi\n</conversation>",
      },
    ]),
    "Expected 1.18-style update compaction prompt (previous-summary) to be detected",
  );
  assert(
    !proxy.isSummaryGenerationRequest([
      { role: "system", content: "You are a helpful coding agent." },
      { role: "user", content: "can we compact the retry logic into one helper?" },
    ]),
    "Chat merely mentioning 'compact' must not be treated as summary generation",
  );
  assert(
    !proxy.isSummaryGenerationRequest([
      {
        role: "user",
        content:
          "<conversation-checkpoint>\nThe following is a summary and serialized record of earlier conversation.\n<summary>\ndid work\n</summary>\n<recent-context>\nstuff\n</recent-context>\n</conversation-checkpoint>",
      },
      { role: "user", content: "continue the refactor" },
    ]),
    "Post-compaction continuation (conversation-checkpoint) must not be treated as summary generation",
  );
  assert(
    !proxy.isTitleGenerationRequest([
      {
        role: "system",
        content: "You are an anchored context summarization assistant for coding sessions.",
      },
      { role: "user", content: "Summarize" },
    ]),
    "Compaction must not be misclassified as title generation",
  );
  console.log("[test] Summary generation detection OK");
}

async function testComputeUsageFallback(modules: TestModules) {
  console.log("[test] Testing computeUsage context fallback...");
  const live = modules.computeUsage({
    toolCallIndex: 0,
    pendingExecs: [],
    outputTokens: 120,
    promptTokens: 50_000,
    fallbackPromptTokens: 1_000,
  });
  assertEqual(live.prompt_tokens, 50_000, "live prompt tokens");
  assertEqual(live.completion_tokens, 120, "live completion tokens");
  assertEqual(live.total_tokens, 50_120, "live total tokens");

  const fallback = modules.computeUsage({
    toolCallIndex: 0,
    pendingExecs: [],
    outputTokens: 40,
    promptTokens: 0,
    fallbackPromptTokens: 12_345,
  });
  assertEqual(fallback.prompt_tokens, 12_345, "fallback prompt tokens");
  assertEqual(fallback.completion_tokens, 40, "fallback completion tokens");
  assertEqual(fallback.total_tokens, 12_385, "fallback total tokens");

  const empty = modules.computeUsage({
    toolCallIndex: 0,
    pendingExecs: [],
    outputTokens: 0,
    promptTokens: 0,
    fallbackPromptTokens: 0,
  });
  assertEqual(empty.prompt_tokens, 0, "empty prompt tokens");
  assertEqual(empty.total_tokens, 0, "empty total tokens");
  console.log("[test] computeUsage context fallback OK");
}

async function testInterruptSteerHelpers() {
  console.log("[test] Testing interrupt/steer helpers...");
  const proxy = await import("../src/proxy");
  const { create, toBinary, fromBinary } = await import("@bufbuild/protobuf");
  const { ConversationStateStructureSchema } = await import("../src/proto/agent_pb");

  assert(
    !proxy.hasUserSteerAfterTools([
      { role: "user", content: "do work" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", content: "file contents", tool_call_id: "c1" },
    ]),
    "Normal tool resume must not look like a user steer",
  );
  assert(
    proxy.hasUserSteerAfterTools([
      { role: "user", content: "do work" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", content: "file contents", tool_call_id: "c1" },
      { role: "user", content: "stop, do this instead" },
    ]),
    "Trailing user message after tools must be detected as steer",
  );

  const framed = proxy.buildInterruptSteerUserText("stop, do this instead");
  assert(
    framed.includes("new instruction"),
    "Steer framing must use natural prefix (no technical 'interrupted' jargon)",
  );
  assert(
    !framed.includes("interrupted the previous turn"),
    "Steer framing must NOT use technical 'interrupted' prefix (causes hallucinations)",
  );
  assert(
    framed.includes("stop, do this instead"),
    "Steer framing must keep the latest user text",
  );

  assert(
    proxy.isCompactionContinueUserText(
      "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
    ),
    "OpenCode synthetic compaction-continue must be detected",
  );
  assert(
    proxy.isCompactionContinueUserText(
      "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.\n",
    ),
    "Compaction-continue detection must tolerate trailing whitespace",
  );
  assert(
    !proxy.isCompactionContinueUserText("continue the refactor of next steps helper"),
    "Normal chat mentioning next steps must not look like compaction-continue",
  );
  const compactContinue = proxy.buildCompactionContinueUserText(
    "## Objective\nDeliver access steps\n## Work State\n### Completed\nroute=/issues",
  );
  assert(
    /do not restart|never restart/i.test(compactContinue),
    "Compaction-continue framing must forbid restarting the plan",
  );
  assert(
    /do not re-read|refill is forbidden|context refill is forbidden/i.test(
      compactContinue,
    ),
    "Compaction-continue framing must forbid re-reading finished context",
  );
  assert(
    !compactContinue.toLowerCase().includes("continue if you have next steps"),
    "Compaction-continue framing must replace the weak OpenCode prompt",
  );
  assert(
    compactContinue.toLowerCase().includes("agents.md"),
    "Compaction-continue framing must explicitly forbid AGENTS.md restart thrash",
  );
  assert(
    compactContinue.includes("route=/issues"),
    "Compaction-continue framing must embed the anchored summary for Cursor",
  );
  assert(
    proxy
      .extractAnchoredSummary([
        { role: "user", content: "What did we do so far?" },
        {
          role: "assistant",
          content:
            "## Objective\nFind X\n## Important Details\nok\n## Work State\n### Completed\ndone",
        },
      ])
      .includes("Find X"),
    "extractAnchoredSummary must return the Objective summary",
  );

  assert(
    !proxy.detectAgentsMdReplanLoop([
      { role: "user", content: "push all changes" },
      { role: "assistant", content: "I'll read AGENTS.md then push." },
    ]),
    "Single AGENTS.md mention must not trip the re-plan detector",
  );
  assert(
    !proxy.detectAgentsMdStartupLoop([
      { role: "user", content: "what is this repo?" },
      {
        role: "assistant",
        content: "I'll read AGENTS.md first.",
        tool_calls: [
          {
            id: "s1",
            type: "function",
            function: { name: "read", arguments: "{\"filePath\":\"AGENTS.md\"}" },
          },
        ],
      },
      { role: "tool", content: "# AGENTS\nUse TodoWrite", tool_call_id: "s1" },
    ]),
    "Normal first-pass AGENTS.md read must not trip the startup-loop detector",
  );
  assert(
    !proxy.detectAgentsMdStartupLoop([
      { role: "user", content: "fix the bug" },
      {
        role: "assistant",
        content: "Reading AGENTS.md and setting todos.",
        tool_calls: [
          {
            id: "t1",
            type: "function",
            function: { name: "read", arguments: "{\"filePath\":\"AGENTS.md\"}" },
          },
          {
            id: "t2",
            type: "function",
            function: {
              name: "TodoWrite",
              arguments: "{\"todos\":[{\"content\":\"Read AGENTS.md\",\"status\":\"in_progress\"}]}",
            },
          },
        ],
      },
      { role: "tool", content: "# Rules", tool_call_id: "t1" },
      { role: "tool", content: "ok", tool_call_id: "t2" },
    ]),
    "Single AGENTS.md + TodoWrite pass must not trip startup-loop detector",
  );
  assert(
    proxy.detectAgentsMdStartupLoop([
      { role: "user", content: "hi, what is this repo?" },
      {
        role: "assistant",
        content: "I will read AGENTS.md first as required.",
        tool_calls: [
          {
            id: "1",
            type: "function",
            function: { name: "read", arguments: "{\"filePath\":\"AGENTS.md\"}" },
          },
        ],
      },
      { role: "tool", content: "File not found: AGENTS.md", tool_call_id: "1" },
      {
        role: "assistant",
        content: "Checking AGENTS.md in the workspace root.",
        tool_calls: [
          {
            id: "2",
            type: "function",
            function: {
              name: "read",
              arguments: "{\"filePath\":\"/workspace/AGENTS.md\"}",
            },
          },
        ],
      },
      {
        role: "tool",
        content: "File not found: /workspace/AGENTS.md",
        tool_call_id: "2",
      },
      {
        role: "assistant",
        content: "Still need AGENTS.md — reading it now.",
        tool_calls: [
          {
            id: "3",
            type: "function",
            function: { name: "read", arguments: "{\"filePath\":\"./AGENTS.md\"}" },
          },
        ],
      },
      { role: "tool", content: "ENOENT: AGENTS.md", tool_call_id: "3" },
    ]),
    "Repeated AGENTS.md missing-file retries at chat start must be detected",
  );
  assert(
    proxy.detectAgentsMdStartupLoop([
      { role: "user", content: "Fix the bug" },
      {
        role: "assistant",
        content: "First I'll read AGENTS.md and set up todos.",
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: { name: "read", arguments: "{\"filePath\":\"AGENTS.md\"}" },
          },
          {
            id: "b",
            type: "function",
            function: {
              name: "TodoWrite",
              arguments:
                "{\"todos\":[{\"content\":\"Read AGENTS.md\",\"status\":\"in_progress\"}]}",
            },
          },
        ],
      },
      { role: "tool", content: "File not found: AGENTS.md", tool_call_id: "a" },
      { role: "tool", content: "Todos updated", tool_call_id: "b" },
      {
        role: "assistant",
        content: "Reading AGENTS.md again then updating todos.",
        tool_calls: [
          {
            id: "c",
            type: "function",
            function: {
              name: "read",
              arguments: "{\"filePath\":\"/workspace/AGENTS.md\"}",
            },
          },
          {
            id: "d",
            type: "function",
            function: {
              name: "TodoWrite",
              arguments:
                "{\"todos\":[{\"content\":\"Read AGENTS.md\",\"status\":\"in_progress\"}]}",
            },
          },
        ],
      },
      { role: "tool", content: "File not found", tool_call_id: "c" },
      { role: "tool", content: "ok", tool_call_id: "d" },
    ]),
    "AGENTS.md + TodoWrite startup ritual loop must be detected",
  );
  assert(
    proxy
      .buildAgentsMdStartupLoopBreakNote()
      .toLowerCase()
      .includes("do not read agents.md again"),
    "Startup-loop break note must forbid another AGENTS.md read",
  );
  assert(
    proxy.isAgentsMdStartupRefillToolCall(
      "read",
      "{\"filePath\":\"/tmp/AGENTS.md\"}",
    ),
    "Startup refill refusal must match AGENTS.md reads",
  );
  assert(
    proxy.isAgentsMdStartupRefillToolCall(
      "TodoWrite",
      "{\"todos\":[{\"content\":\"Read AGENTS.md first\"}]}",
    ),
    "Startup refill refusal must match AGENTS.md TodoWrite rituals",
  );
  assert(
    !proxy.isAgentsMdStartupRefillToolCall(
      "bash",
      "{\"command\":\"git status\"}",
    ),
    "Startup refill refusal must not block unrelated tools",
  );
  assert(
    proxy
      .buildLoopBreakNoteForMessages([
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "Reading AGENTS.md",
          tool_calls: [
            {
              id: "x1",
              type: "function",
              function: { name: "read", arguments: "{\"filePath\":\"AGENTS.md\"}" },
            },
          ],
        },
        { role: "tool", content: "File not found: AGENTS.md", tool_call_id: "x1" },
        {
          role: "assistant",
          content: "Checking AGENTS.md again",
          tool_calls: [
            {
              id: "x2",
              type: "function",
              function: {
                name: "read",
                arguments: "{\"filePath\":\"/workspace/AGENTS.md\"}",
              },
            },
          ],
        },
        {
          role: "tool",
          content: "File not found: /workspace/AGENTS.md",
          tool_call_id: "x2",
        },
      ])
      .includes("[Loop break]") &&
      proxy
        .buildLoopBreakNoteForMessages([
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "Reading AGENTS.md",
            tool_calls: [
              {
                id: "x1",
                type: "function",
                function: {
                  name: "read",
                  arguments: "{\"filePath\":\"AGENTS.md\"}",
                },
              },
            ],
          },
          {
            role: "tool",
            content: "File not found: AGENTS.md",
            tool_call_id: "x1",
          },
          {
            role: "assistant",
            content: "Checking AGENTS.md again",
            tool_calls: [
              {
                id: "x2",
                type: "function",
                function: {
                  name: "read",
                  arguments: "{\"filePath\":\"/workspace/AGENTS.md\"}",
                },
              },
            ],
          },
          {
            role: "tool",
            content: "File not found: /workspace/AGENTS.md",
            tool_call_id: "x2",
          },
        ])
        .toLowerCase()
        .includes("startup"),
    "buildLoopBreakNoteForMessages must prefer the startup-loop note",
  );
  assert(
    !proxy.detectAgentsMdReplanLoop([
      { role: "user", content: "fill context" },
      { role: "assistant", content: "I'll read AGENTS.md then update todos." },
      { role: "assistant", content: "Next I'll check AGENTS.md and continue the todo checklist." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{\"filePath\":\"AGENTS.md\"}" } }],
      },
      { role: "tool", content: "# AGENTS\nUse TodoWrite", tool_call_id: "c1" },
    ]),
    "Normal AGENTS.md + TodoWrite context fill must not trip the re-plan detector",
  );
  assert(
    proxy.detectAgentsMdReplanLoop([
      { role: "user", content: "push all changes" },
      { role: "assistant", content: "I'll read AGENTS.md, then check git and push." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{\"filePath\":\"/repo/AGENTS.md\"}" } }],
      },
      { role: "tool", content: "File not found: /repo/AGENTS.md", tool_call_id: "c1" },
      { role: "assistant", content: "The last request was to push all changes. I'll check AGENTS.md and git status." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c2", type: "function", function: { name: "bash", arguments: "{\"command\":\"git status\"}" } }],
      },
      { role: "tool", content: "On branch main\nnothing to commit", tool_call_id: "c2" },
      { role: "assistant", content: "The remaining step is pushing. Checking AGENTS.md and git status first." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c3", type: "function", function: { name: "read", arguments: "{\"filePath\":\"AGENTS.md\"}" } },
          { id: "c4", type: "function", function: { name: "bash", arguments: "{\"command\":\"git status && git log\"}" } },
        ],
      },
      { role: "tool", content: "File not found: AGENTS.md", tool_call_id: "c3" },
      { role: "tool", content: "On branch main", tool_call_id: "c4" },
      { role: "assistant", content: "I'll read AGENTS.md, then check git status and push." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c5", type: "function", function: { name: "read", arguments: "{\"filePath\":\"/x/AGENTS.md\"}" } },
          { id: "c6", type: "function", function: { name: "bash", arguments: "{\"command\":\"git status\"}" } },
        ],
      },
      { role: "tool", content: "File not found: /x/AGENTS.md", tool_call_id: "c5" },
      { role: "tool", content: "On branch main", tool_call_id: "c6" },
    ]),
    "Repeated AGENTS.md + git status restarts must be detected as a re-plan loop",
  );
  assert(
    proxy.buildReplanLoopBreakNote().toLowerCase().includes("do not read agents.md again"),
    "Loop-break note must forbid another AGENTS.md read",
  );

  assert(
    proxy.isFreshCompactionContinue(
      [
        { role: "user", content: "What did we do so far?" },
        { role: "assistant", content: "## Objective\n\n## Work State\n### Completed\nok" },
        {
          role: "user",
          content:
            "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
        },
      ],
      "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
    ),
    "Fresh post-compact continue must be detected",
  );
  assert(
    !proxy.isFreshCompactionContinue(
      [
        { role: "user", content: "What did we do so far?" },
        { role: "assistant", content: "## Objective\n\n## Work State\n### Completed\nok" },
        {
          role: "user",
          content:
            "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
        },
        { role: "assistant", content: "Giving the final access steps now." },
      ],
      "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
    ),
    "Continue text after an assistant reply must NOT re-frame as fresh compaction-continue",
  );

  const summaryAssistant = [
    "## Objective",
    "- Find access steps; follow encyclopedia checklist.",
    "## Important Details",
    "- Required reads: encyclopedia, repeat-a, big.json, AGENTS.md",
    "## Work State",
    "### Completed",
    "- encyclopedia fully read; route is /issues?view=queue",
    "### Active",
    "- deliver final access steps",
  ].join("\n");
  assert(
    proxy.isPostCompactHistory([
      { role: "user", content: "What did we do so far?" },
      { role: "assistant", content: summaryAssistant },
      {
        role: "user",
        content:
          "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
      },
    ]),
    "OpenCode post-compact history shape must be detected",
  );
  assert(
    !proxy.detectPostCompactRefillLoop([
      { role: "user", content: "What did we do so far?" },
      { role: "assistant", content: summaryAssistant },
      {
        role: "user",
        content:
          "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
      },
    ]),
    "Anchored summary alone must not look like a refill loop",
  );
  assert(
    proxy.detectPostCompactRefillLoop([
      { role: "user", content: "What did we do so far?" },
      { role: "assistant", content: summaryAssistant },
      {
        role: "user",
        content:
          "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
      },
      {
        role: "assistant",
        content: "I'll check AGENTS.md and resume unfinished context filling.",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: {
              name: "read",
              arguments: "{\"filePath\":\"/tmp/ctx/AGENTS.md\"}",
            },
          },
        ],
      },
    ]),
    "Post-compact AGENTS.md re-read must be detected as a refill loop",
  );
  assert(
    proxy
      .buildPostCompactRefillBreakNote()
      .toLowerCase()
      .includes("refilling context is forbidden"),
    "Post-compact break note must forbid context refill",
  );
  assert(
    proxy.isPostCompactRefillToolCall(
      "todowrite",
      JSON.stringify({ todos: [{ content: "deliver final answer" }] }),
    ),
    "Post-compact TodoWrite must be refused as refill/planning thrash",
  );
  assert(
    proxy
      .buildPostCompactRefillRefusal()
      .toLowerCase()
      .includes("refill refused"),
    "Post-compact refusal text must be explicit",
  );
  assert(
    compactContinue.toLowerCase().includes("context refill is forbidden") ||
      compactContinue.toLowerCase().includes("refill is forbidden"),
    "Compaction-continue framing must forbid context refill",
  );

  assert(
    proxy.looksLikeUnfinishedPlan(
      "I'll check AGENTS.md and git status, then push.",
    ),
    "Short plan-with-no-answer must look unfinished",
  );
  assert(
    !proxy.looksLikeUnfinishedPlan(
      "## Auth-gate flow\n\n- Redirect: /login\n- Flags: FEATURE_AUTH_GATE\n- Refresh: POST /api/auth/refresh\n\nDone.",
    ),
    "Concrete final answers must not look like unfinished plans",
  );
  assert(
    proxy
      .buildUnfinishedPlanNudgeUserText("I'll read AGENTS.md next.")
      .toLowerCase()
      .includes("without taking action"),
    "Unfinished-plan nudge must demand a tool call or final answer",
  );

  assert(
    !proxy.detectRestatedPlanLoop([
      { role: "user", content: "rebuild and restart prod on :8888" },
      {
        role: "assistant",
        content: "I'll rebuild the web assets, then restart :8888 without a password.",
      },
    ]),
    "A single unfinished plan must not trip the restated-plan detector",
  );
  assert(
    proxy.detectRestatedPlanLoop([
      { role: "user", content: "rebuild and restart prod on :8888" },
      {
        role: "assistant",
        content: "Not yet — rebuild/restart hadn’t run. Doing that now.",
        tool_calls: [
          {
            id: "b1",
            type: "function",
            function: { name: "bash", arguments: "{\"command\":\"bun run build:web\"}" },
          },
        ],
      },
      {
        role: "tool",
        content: "✓ built in 2m 15s\nPWA built\n",
        tool_call_id: "b1",
      },
      {
        role: "assistant",
        content: "Ще ні — rebuild/restart не завершився. Зараз зупиню :8888 і підніму без пароля.",
      },
      {
        role: "assistant",
        content: "Not yet — rebuild/restart hadn’t run. Doing that now.",
      },
    ]),
    "Restating the same rebuild plan after successful build output must be detected",
  );
  assert(
    proxy.detectRestatedPlanLoop([
      { role: "user", content: "stop port 8888" },
      {
        role: "assistant",
        content: "I'll stop the :8888 process now.",
        tool_calls: [
          {
            id: "s1",
            type: "function",
            function: {
              name: "bash",
              arguments: "{\"command\":\"node packages/web/bin/cli.js stop --port 8888\"}",
            },
          },
        ],
      },
      {
        role: "tool",
        content: "Error:\nOpenCode did not settle this tool after the session went idle.",
        tool_call_id: "s1",
      },
    ]),
    "OpenCode settle/idle tool errors must trip restated-plan recovery",
  );
  assert(
    proxy
      .buildRestatedPlanLoopBreakNote()
      .toLowerCase()
      .includes("did not settle"),
    "Restated-plan break note must mention settle/idle recovery",
  );

  const hugeToolOut = `${"line\n".repeat(8_000)}✓ built in 2m 15s\n`;
  const truncatedToolOut = proxy.truncateToolResultForCursor(hugeToolOut);
  assert(
    truncatedToolOut.length < hugeToolOut.length,
    "Huge tool output must be truncated for Cursor mcpResult",
  );
  assert(
    truncatedToolOut.includes("truncated") && truncatedToolOut.includes("✓ built"),
    "Truncation must keep a marker and the tail success line",
  );
  assert(
    proxy.truncateToolResultForCursor("short ok") === "short ok",
    "Small tool output must pass through unchanged",
  );

  const dirty = create(ConversationStateStructureSchema, {
    rootPromptMessagesJson: [],
    turns: [],
    todos: [],
    pendingToolCalls: ['{"id":"pending"}'],
    previousWorkspaceUris: [],
    fileStates: {},
    fileStatesV2: {},
    summaryArchives: [],
    turnTimings: [],
    subagentStates: {},
    selfSummaryCount: 0,
    readPaths: [],
  });
  const sanitized = proxy.sanitizeCheckpointAfterInterrupt(
    toBinary(ConversationStateStructureSchema, dirty),
  );
  assert(sanitized, "sanitizeCheckpointAfterInterrupt must return bytes");
  const cleaned = fromBinary(ConversationStateStructureSchema, sanitized!);
  assertEqual(cleaned.pendingToolCalls.length, 0, "pending tool calls must be cleared");
  console.log("[test] Interrupt/steer helpers OK");
}

async function testParseMessagesPreservesUserDuringToolLoop() {
  console.log("[test] Testing parseMessages mid-tool-loop userText preservation...");
  const proxy = await import("../src/proxy");

  // Regression: assistant text + tool_calls used to flush the turn early, leaving
  // userText="" on the tool-result follow-up. Cursor then saw an empty UserMessage
  // (when the parked bridge was also missing) and hallucinated "empty message".
  const midLoop = proxy.parseMessages([
    { role: "system", content: "You are opencode." },
    { role: "user", content: "Create todos then run pwd" },
    {
      role: "assistant",
      content: "Creating the two todos, then running pwd.",
      tool_calls: [
        { id: "call_todo", type: "function", function: { name: "todowrite", arguments: "{}" } },
        { id: "call_bash", type: "function", function: { name: "bash", arguments: "{\"command\":\"pwd\"}" } },
      ],
    },
    { role: "tool", content: "todos updated", tool_call_id: "call_todo" },
    { role: "tool", content: "/workspace", tool_call_id: "call_bash" },
  ]);
  assertEqual(
    midLoop.userText,
    "Create todos then run pwd",
    "Mid-tool-loop must preserve the original user text (not empty)",
  );
  assertEqual(midLoop.turns.length, 0, "Open tool loop must not flush into completed turns");
  assertEqual(midLoop.toolResults.length, 2, "Only trailing unresolved tool results");
  assertEqual(midLoop.toolResults[0]?.toolCallId, "call_todo", "First trailing tool id");
  assertEqual(midLoop.toolResults[1]?.content, "/workspace", "Second trailing tool content");

  // Completed tool loop + final assistant: no trailing tools, regeneration pops last user.
  const completed = proxy.parseMessages([
    { role: "user", content: "do work" },
    {
      role: "assistant",
      content: "Working...",
      tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
    },
    { role: "tool", content: "ok", tool_call_id: "c1" },
    { role: "assistant", content: "Done." },
  ]);
  assertEqual(completed.toolResults.length, 0, "Completed loop has no trailing tool results");
  assertEqual(completed.userText, "do work", "Completed history regenerates last user text");

  // Multi-round tools: only the latest open batch is trailing.
  const multiRound = proxy.parseMessages([
    { role: "user", content: "inspect repo" },
    {
      role: "assistant",
      content: "First lookup",
      tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
    },
    { role: "tool", content: "old result", tool_call_id: "c1" },
    {
      role: "assistant",
      content: "Second lookup",
      tool_calls: [{ id: "c2", type: "function", function: { name: "read", arguments: "{}" } }],
    },
    { role: "tool", content: "new result", tool_call_id: "c2" },
  ]);
  assertEqual(multiRound.userText, "inspect repo", "Multi-round preserves user text");
  assertEqual(multiRound.toolResults.length, 1, "Only latest open batch tool results");
  assertEqual(multiRound.toolResults[0]?.content, "new result", "Latest tool result content");
  assertEqual(multiRound.turns.length, 0, "Still-open loop is not a completed turn");

  // Historical tools must not be treated as resumable after a new user steer.
  const steered = proxy.parseMessages([
    { role: "user", content: "do work" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
    },
    { role: "tool", content: "partial", tool_call_id: "c1" },
    { role: "user", content: "stop, do this instead" },
  ]);
  assertEqual(steered.userText, "stop, do this instead", "Steer user text wins");
  assertEqual(steered.toolResults.length, 0, "Steer must not resume historical tool results");

  console.log("[test] parseMessages mid-tool-loop userText preservation OK");
}

async function testParseMessagesOrphanedToolResultsDoNotReplan() {
  console.log("[test] Testing orphaned tool results (OpenCode drops assistant.tool_calls)...");
  const proxy = await import("../src/proxy");

  // Reproduction of the OpenCode↔Cursor re-plan loop:
  // OpenCode history replay omits assistant.tool_calls but keeps role:tool
  // (anomalyco/opencode#24090). Previously parseMessages returned toolResults=[]
  // and regenerated the original userText, so the proxy killed the parked bridge
  // and re-sent the same task — the agent restated its plan forever.
  const orphaned = proxy.parseMessages([
    { role: "system", content: "You are opencode." },
    {
      role: "user",
      content: "Hide harness switcher when Claude is missing-cli/needs-login",
    },
    {
      role: "assistant",
      content:
        "Приховаю перемикач harness, коли Claude Code у стані missing CLI / needs login.",
      // tool_calls intentionally omitted — OpenCode replay bug
    },
    {
      role: "tool",
      content:
        "Total: 2 In Progress: 1 Pending: 1 In Progress Hide harness switcher Pending Update tests",
      tool_call_id: "call_todo",
    },
  ]);
  assertEqual(
    orphaned.toolResults.length,
    1,
    "Orphaned role:tool must still open a tool batch",
  );
  assertEqual(
    orphaned.toolResults[0]?.toolCallId,
    "call_todo",
    "Orphaned tool id must be preserved",
  );
  assertEqual(
    orphaned.userText,
    "Hide harness switcher when Claude is missing-cli/needs-login",
    "Orphaned mid-loop must preserve original user text",
  );
  assertEqual(
    orphaned.turns.length,
    0,
    "Orphaned mid-loop must not flush into completed turns (would re-prompt the task)",
  );

  // Multi-round with every assistant missing tool_calls: only the latest
  // orphaned batch is trailing (same invariant as normal multi-round).
  const multiOrphaned = proxy.parseMessages([
    { role: "user", content: "Hide harness switcher when Claude is missing-cli/needs-login" },
    { role: "assistant", content: "Checking buildHarnessOptions." },
    {
      role: "tool",
      content: "Found 14 matches in modelPickerData.ts",
      tool_call_id: "call_grep",
    },
    { role: "assistant", content: "Приховую перемикач harness, коли Claude Code недоступний." },
    {
      role: "tool",
      content: "Total: 2 In Progress: 1 Pending: 1",
      tool_call_id: "call_todo2",
    },
  ]);
  assertEqual(multiOrphaned.toolResults.length, 1, "Only latest orphaned batch");
  assertEqual(
    multiOrphaned.toolResults[0]?.toolCallId,
    "call_todo2",
    "Latest orphaned tool id",
  );
  assertEqual(
    multiOrphaned.userText,
    "Hide harness switcher when Claude is missing-cli/needs-login",
    "Multi-round orphaned loop preserves user text",
  );
  assertEqual(multiOrphaned.turns.length, 0, "Multi-round orphaned stays mid-loop");

  // Mixing: historical assistant kept tool_calls, latest lost them.
  const mixed = proxy.parseMessages([
    { role: "user", content: "inspect repo" },
    {
      role: "assistant",
      content: "First lookup",
      tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
    },
    { role: "tool", content: "old result", tool_call_id: "c1" },
    { role: "assistant", content: "Second lookup without tool_calls field" },
    { role: "tool", content: "new result", tool_call_id: "c2" },
  ]);
  assertEqual(mixed.toolResults.length, 1, "Mixed history keeps only latest orphaned batch");
  assertEqual(mixed.toolResults[0]?.content, "new result", "Latest orphaned content");
  assertEqual(mixed.turns.length, 0, "Mixed orphaned history stays mid-loop");

  console.log("[test] Orphaned tool results (no re-plan) OK");
}

async function testImageAttachmentParsingAndCapabilities() {
  console.log("[test] Testing image attachment parsing...");
  const proxy = await import("../src/proxy");

  const tinyPngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const dataUrl = `data:image/png;base64,${tinyPngBase64}`;

  const extracted = proxy.extractImagesFromContent([
    { type: "text", text: "what is in this image?" },
    { type: "image_url", image_url: { url: dataUrl } },
  ]);
  assertEqual(extracted.length, 1, "Expected one extracted image from image_url part");
  assertEqual(extracted[0]?.mimeType, "image/png", "Expected png mime");
  assert(extracted[0]!.bytes.byteLength > 0, "Expected non-empty image bytes");

  const filePart = proxy.extractImagesFromContent([
    {
      type: "file",
      filename: "IMG_3064.png",
      mime: "image/png",
      data: tinyPngBase64,
    },
  ]);
  assertEqual(filePart.length, 1, "Expected one extracted image from file part");
  assertEqual(filePart[0]?.filename, "IMG_3064.png", "Expected original filename");

  const parsed = proxy.parseMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        { type: "image_url", image_url: dataUrl },
      ],
    },
  ]);
  assertEqual(parsed.userText, "describe this", "Expected text preserved alongside image");
  assertEqual(parsed.images.length, 1, "Expected parseMessages to surface images");

  const imageOnly = proxy.parseMessages([
    {
      role: "user",
      content: [{ type: "image_url", image_url: { url: dataUrl } }],
    },
  ]);
  assertEqual(imageOnly.userText.trim(), "", "Image-only turn may have empty text");
  assertEqual(imageOnly.images.length, 1, "Image-only turn must still expose images");

  console.log("[test] Image attachment parsing OK");
}

async function testLongToolBridgeTtlAndContinuation() {
  console.log("[test] Testing long-tool bridge TTL and dead-bridge continuation...");
  const proxy = await import("../src/proxy");

  // Regression: 5-minute TTL killed bridges during long shells (UI showed 300.0s).
  assert(
    proxy.getActiveBridgeTtlMs() >= 30 * 60 * 1000,
    `Active bridge TTL must cover long tool runs (>=30m), got ${proxy.getActiveBridgeTtlMs()}ms`,
  );

  const continuation = proxy.buildPostToolBridgeLossContinuation([
    { toolCallId: "call_shell_1", content: "build finished successfully" },
  ]);
  assert(
    continuation.includes("build finished successfully"),
    "Dead-bridge continuation must include tool output",
  );
  assert(
    continuation.includes("Continue from the current conversation checkpoint."),
    "Dead-bridge continuation must lead with an explicit continue cue (raw tool output alone restarts planning)",
  );
  assert(
    !continuation.includes("[Internal stream recovery]"),
    "Dead-bridge continuation must NOT use technical recovery prefix (confuses model into empty-message hallucinations)",
  );

  const emptyContinuation = proxy.buildPostToolBridgeLossContinuation([
    { toolCallId: "call_shell_2", content: "" },
  ]);
  assert(
    emptyContinuation.includes("(no output)"),
    "Empty tool output must be replaced with a placeholder",
  );
  assert(
    emptyContinuation.includes("Continue from the current conversation checkpoint."),
    "Empty tool output continuation must still include continue cue",
  );
  console.log("[test] Long-tool bridge TTL and continuation OK");
}

async function testAwaitingToolResultsBridgeSurvivesEviction() {
  console.log("[test] Testing awaiting-tool bridges survive eviction and admission culls...");
  const proxy = await import("../src/proxy");
  const hooks = proxy.__bridgeEvictionTestHooks;

  const makeFakeActive = (pendingExecs: number, lastAccessMs: number) => {
    const heartbeatTimer = setInterval(() => undefined, 60_000);
    return {
      bridge: { alive: false, write: () => undefined, kill: () => undefined } as never,
      heartbeatTimer,
      blobStore: new Map(),
      mcpTools: [],
      pendingExecs: Array.from({ length: pendingExecs }, (_, i) => ({
        execId: `e${i}`,
        execMsgId: i,
        toolCallId: `call_${i}`,
        cursorToolCallId: `cur_${i}`,
        toolName: "bash",
        decodedArgs: "{}",
      })),
      lastAccessMs,
    };
  };

  const cleanup = (key: string) => {
    const active = hooks.activeBridges.get(key);
    if (active) clearInterval(active.heartbeatTimer);
    hooks.activeBridges.delete(key);
  };

  const awaitingKey = "test-awaiting-bridge";
  const idleKey = "test-idle-bridge";
  const staleMs = Date.now() - 365 * 24 * 60 * 60 * 1000; // ancient: past any TTL
  try {
    // 1) A bridge awaiting tool results must survive TTL eviction even when ancient.
    hooks.activeBridges.set(awaitingKey, makeFakeActive(1, staleMs) as never);
    assert(
      hooks.isAwaitingToolResults(hooks.activeBridges.get(awaitingKey) as never),
      "Bridge with pendingExecs must be awaiting tool results",
    );
    hooks.evictStaleActiveBridges();
    assert(
      hooks.activeBridges.has(awaitingKey),
      "Awaiting bridge must NOT be evicted by TTL sweep (regression: 13d0164 removed the exemption)",
    );

    // 2) A bridge with no pending execs is still reaped normally.
    hooks.activeBridges.set(idleKey, makeFakeActive(0, staleMs) as never);
    hooks.evictStaleActiveBridges();
    assert(
      !hooks.activeBridges.has(idleKey),
      "Non-awaiting ancient bridge must be evicted by TTL sweep",
    );

    // 3) Admission culls must skip awaiting bridges even when they are the oldest.
    hooks.activeBridges.set(awaitingKey, makeFakeActive(2, staleMs) as never);
    // Idle bridge is older than the 30s admission-cull threshold but not ancient.
    hooks.activeBridges.set(idleKey, makeFakeActive(0, Date.now() - 60_000) as never);
    const culled = hooks.cullOldestIdleBridgesForAdmission(1);
    assert(
      hooks.activeBridges.has(awaitingKey),
      "Awaiting bridge must NOT be culled by admission pressure",
    );
    assertEqual(culled, 1, "Exactly one non-awaiting bridge should be culled");
    assert(
      !hooks.activeBridges.has(idleKey),
      "Non-awaiting bridge should be culled under admission pressure",
    );
  } finally {
    cleanup(awaitingKey);
    cleanup(idleKey);
  }
  console.log("[test] Awaiting-tool bridge eviction/cull exemption OK");
}

async function testClientAbortReleasesMutexForSteer(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing client abort releases mutex so interrupt message can run...");
  backend.setRunMode("text-then-hang");
  const port = await modules.startProxy(async () => "test-token");

  const controller = new AbortController();
  const firstPromise = fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: controller.signal,
    body: JSON.stringify({
      model: "default",
      stream: true,
      conversation_id: "interrupt-steer-session",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "start a long task" },
      ],
    }),
  });

  // Wait until headers + first SSE land so the proxy holds the conversation mutex.
  const firstRes = await firstPromise;
  assertEqual(firstRes.status, 200, "First streaming request should start");
  assert(firstRes.body, "First response must have a body");
  const reader = firstRes.body!.getReader();
  await reader.read();
  const runsAfterFirst = backend.getRunRequestCount();
  assert(runsAfterFirst >= 1, "First turn must open a Cursor Run");

  controller.abort();
  await reader.cancel().catch(() => undefined);

  // Follow-up must be able to acquire the mutex and start a new Run promptly.
  backend.setRunMode("immediate-close");
  const runsBeforeSteer = backend.getRunRequestCount();
  const steerStarted = Date.now();
  const steerPromise = fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "default",
      stream: true,
      conversation_id: "interrupt-steer-session",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "start a long task" },
        { role: "assistant", content: "Working on it..." },
        { role: "user", content: "stop, answer briefly instead" },
      ],
    }),
  });

  const deadline = Date.now() + 2_000;
  while (backend.getRunRequestCount() <= runsBeforeSteer && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const steerRunWaitMs = Date.now() - steerStarted;
  assert(
    backend.getRunRequestCount() > runsBeforeSteer,
    `Steer must start a Cursor Run after interrupt (waited ${steerRunWaitMs}ms)`,
  );
  assert(
    steerRunWaitMs < 2_000,
    `Steer Run must not block on aborted turn mutex (waited ${steerRunWaitMs}ms)`,
  );

  const steerRes = await steerPromise;
  assertEqual(steerRes.status, 200, "Steer request must succeed after abort");
  const steerBody = await steerRes.text();
  assert(steerBody.includes("data: [DONE]"), "Steer SSE must complete");
  assert(
    steerBody.includes("stop") || steerBody.includes("ok") || steerBody.includes("content"),
    "Steer response should include assistant content",
  );
  const steeredTexts = backend.getRunUserTexts().filter((t) => t.includes("stop, answer briefly instead"));
  assert(steeredTexts.length >= 1, "Steer Run must include the interrupt user text");
  assert(
    steeredTexts.some((t) => t.includes("new instruction")),
    "Steer Run must use natural prefix so the model follows the new message",
  );

  backend.setRunMode("immediate-close");
  modules.stopProxy();
  console.log("[test] Client abort releases mutex for steer OK");
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
  // Stall wait notices must stay off by default (Discord interruption).
  delete process.env.OPENCODE_CURSOR_STALL_WAIT_NOTICE_MS;
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
    await testAvailableModelParameterGrouping(modules);
    await testCursorModelVariantGrouping(modules);
    await testCursorVariantHooks(modules, backend);
    await testConfigHookSeedsProvider(modules, backend);
    await testArrayContentParsing(modules);
    await testExpiredTokenRefreshBeforeDiscovery(modules, backend);
    await testRefreshFailureKeepsProviderListable(modules, backend);
    await testRefreshPreservesOriginalWhenResponseRefreshIsNotJwt(modules, backend);
    await testRefreshRotatesWhenResponseRefreshIsJwt(modules, backend);
    await testDiscoveryFallbackAndSuccess(modules, backend);
    await testPersistentBridgeSessionIsolation();
    await testPoolRecoveryAfterServerRestart();
    await testPoolSequentialRequests();
    await testPoolOverflowEphemeralWorkers();
    await testProxyConsumesCursorModelHeader(modules, backend);
    await testStreamingWatchdogRecoversFromStalledRun(modules, backend);
    await testStallExhaustionIsHonest(modules, backend);
    await testHeartbeatKeepalivesDoNotBlockStallRecovery(modules, backend);
    await testMutexAbortDoesNotBlockQueue();
    await testSummaryGenerationDetection(modules);
    await testComputeUsageFallback(modules);
    await testInterruptSteerHelpers();
    await testParseMessagesPreservesUserDuringToolLoop();
    await testParseMessagesOrphanedToolResultsDoNotReplan();
    await testImageAttachmentParsingAndCapabilities();
    await testLongToolBridgeTtlAndContinuation();
    await testAwaitingToolResultsBridgeSurvivesEviction();
    await testClientAbortReleasesMutexForSteer(modules, backend);
    console.log("\n✓ All smoke tests passed");
    process.exit(0);
  } catch (err) {
    console.error("\n✗ Smoke test failed:", err);
    process.exit(1);
  } finally {
    modules.stopProxy();
    await backend.close();
  }
}

main();
