/** Cursor OAuth and stateless UnifiedChat provider for OpenCode. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import {
  refreshCursorToken,
  RefreshTokenInvalidError,
} from "./auth.js";
import {
  getPendingCursorLogin,
  startCursorBrowserLogin,
  waitForCursorBrowserLogin,
} from "./auth-login.js";
import { createCursorFetch } from "./cursor-fetch.js";
import { log } from "./log.js";
import {
  clearModelCache,
  filterSupportedCursorModels,
  getCursorModels,
  isLoginPlaceholderModel,
  LOGIN_PLACEHOLDER_MODELS,
  loginPlaceholderModels,
  type CursorModel,
} from "./models.js";
import {
  CURSOR_SELECTION_HEADER,
  encodeCursorModelRequest,
} from "./model-selection.js";
import { UnifiedChatTransport } from "./unified-chat-transport.js";

const CURSOR_PROVIDER_ID = "cursor";
const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";
const CURSOR_VARIANT_OPTION = "cursorVariant";
const CURSOR_LOGICAL_BASE_URL = "https://cursor.invalid/v1";
const ZERO_COST = Object.freeze({
  input: 0,
  output: 0,
  cache: { read: 0, write: 0 },
});
const GENERATED_VARIANT_KEYS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

interface CursorOAuthAuth {
  type: "oauth";
  access?: string;
  refresh: string;
  expires: number;
}

type ProviderModelsHook = NonNullable<
  NonNullable<Hooks["provider"]>["models"]
>;
type ProviderModelMap = Awaited<ReturnType<ProviderModelsHook>>;
type ProviderModel = ProviderModelMap[string];

interface ProviderRecord {
  models?: ProviderModelMap;
}

interface ConfigRecord {
  provider?: Record<string, unknown>;
}

type AuthGetter = () => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCursorOAuthAuth(auth: unknown): auth is CursorOAuthAuth {
  return (
    isRecord(auth) &&
    auth.type === "oauth" &&
    typeof auth.refresh === "string" &&
    auth.refresh.length > 0 &&
    typeof auth.expires === "number"
  );
}

function isUsableAccess(
  auth: CursorOAuthAuth,
): auth is CursorOAuthAuth & { access: string } {
  return (
    typeof auth.access === "string" &&
    auth.access.length > 0 &&
    auth.expires >= Date.now()
  );
}

/**
 * OpenCode plugin for browser Cursor OAuth and direct stateless UnifiedChat.
 * Register `@otto-assistant/opencode-cursor-auth`; do not load the legacy
 * Cursor provider package alongside it.
 */
export const CursorAuthPlugin: Plugin = async (
  input: PluginInput,
): Promise<Hooks> => {
  const transport = new UnifiedChatTransport({
    minSize: 0,
    url: process.env.CURSOR_API_URL,
  });
  let refreshInFlight: Promise<string> | undefined;
  let clearSeededLoginPlaceholder = (): void => {};

  const accessToken = async (
    getAuth: AuthGetter,
    getLatestAuth: AuthGetter = getAuth,
  ): Promise<string> => {
    const current = await getAuth();
    if (!isCursorOAuthAuth(current)) {
      throw new Error("Cursor OAuth is not configured");
    }
    if (isUsableAccess(current)) return current.access;
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async () => {
      const latest = await getLatestAuth();
      if (!isCursorOAuthAuth(latest)) {
        throw new Error("Cursor OAuth is not configured");
      }
      if (isUsableAccess(latest)) return latest.access;

      const refreshed = await refreshCursorToken(latest.refresh);
      await input.client.auth.set({
        throwOnError: true,
        path: { id: CURSOR_PROVIDER_ID },
        body: {
          type: "oauth",
          refresh: refreshed.refresh,
          access: refreshed.access,
          expires: refreshed.expires,
        },
      });
      clearModelCache();
      return refreshed.access;
    })();

    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = undefined;
    }
  };

  const loadRuntime = async (
    getAuth: AuthGetter,
    provider?: unknown,
    getLatestAuth: AuthGetter = getAuth,
  ): Promise<{
    liveModels: CursorModel[];
    providerModels: ProviderModelMap;
  }> => {
    let liveModels: CursorModel[] = [];
    try {
      const token = await accessToken(getAuth, getLatestAuth);
      liveModels = filterSupportedCursorModels(
        await getCursorModels(token, transport),
      );
    } catch (error) {
      log.error(
        error instanceof RefreshTokenInvalidError
          ? "[opencode-cursor] Cursor refresh rejected; browser login is required"
          : "[opencode-cursor] Cursor authentication or model discovery is unavailable",
      );
    }

    if (liveModels.length > 0) {
      clearSeededLoginPlaceholder();
      clearSeededLoginPlaceholder = (): void => {};
    }

    const visibleModels =
      liveModels.length > 0 ? liveModels : currentLoginPlaceholderModels();
    const providerModels = buildCursorProviderModels(visibleModels);
    if (isRecord(provider)) {
      (provider as ProviderRecord).models = providerModels;
    }
    return { liveModels, providerModels };
  };

  return {
    async config(config) {
      const visibleModels = await resolveConfigModels(accessToken, transport);
      const liveModels = filterSupportedCursorModels(visibleModels);
      clearSeededLoginPlaceholder = ensureCursorProviderConfig(
        config,
        liveModels.length > 0 ? liveModels : visibleModels,
      );
    },

    "chat.headers": async (hookInput, output) => {
      if (hookInput.model.providerID !== CURSOR_PROVIDER_ID) return;
      const messageModel = hookInput.message.model as typeof hookInput.message.model & {
        variant?: unknown;
      };
      const variant =
        typeof messageModel.variant === "string"
          ? messageModel.variant
          : undefined;
      output.headers[CURSOR_SELECTION_HEADER] =
        encodeCursorModelRequest({
          modelId: hookInput.model.id,
          ...(variant ? { variant } : {}),
        });
    },

    "chat.params": async (hookInput, output) => {
      if (hookInput.model.providerID !== CURSOR_PROVIDER_ID) return;
      delete output.options.reasoningEffort;
      delete output.options[CURSOR_VARIANT_OPTION];
    },

    provider: {
      id: CURSOR_PROVIDER_ID,
      async models(provider, context) {
        const runtime = await loadRuntime(
          async () => context.auth,
          provider,
          async () => readStoredCursorAuth(),
        );
        return runtime.providerModels;
      },
    },

    auth: {
      provider: CURSOR_PROVIDER_ID,
      async loader(getAuth, provider) {
        const runtime = await loadRuntime(getAuth, provider);
        if (runtime.liveModels.length === 0) return {};
        return {
          apiKey: "",
          fetch: createCursorFetch({
            getAccessToken: () => accessToken(getAuth),
            getModels: () => runtime.liveModels,
            transport,
          }),
        };
      },
      methods: [
        {
          type: "oauth",
          label: "Login with Cursor",
          async authorize() {
            const pending = await startCursorBrowserLogin();
            return {
              url: pending.url,
              instructions:
                "Open the URL below in your browser to authorize Cursor (same as `opencode auth login`). After you approve access, return here and click Complete; the live model list will load automatically. No API key is required.",
              method: "auto" as const,
              async callback() {
                const tokens = await waitForCursorBrowserLogin();
                clearModelCache();
                return {
                  type: "success" as const,
                  refresh: tokens.refresh,
                  access: tokens.access,
                  expires: tokens.expires,
                };
              },
            };
          },
        },
      ],
    },
    async dispose() {
      transport.close();
    },
  };
};

function currentLoginPlaceholderModels(): CursorModel[] {
  const pending = getPendingCursorLogin();
  return pending && !pending.completed
    ? loginPlaceholderModels(pending.url)
    : LOGIN_PLACEHOLDER_MODELS;
}

function buildCursorProviderModels(
  models: readonly CursorModel[],
): ProviderModelMap {
  return Object.fromEntries(
    models.map((model) => [model.id, buildProviderModel(model)]),
  );
}

function buildProviderModel(model: CursorModel): ProviderModel {
  return {
    id: model.id,
    providerID: CURSOR_PROVIDER_ID,
    api: {
      id: model.id,
      url: CURSOR_LOGICAL_BASE_URL,
      npm: OPENAI_COMPATIBLE_NPM,
    },
    name: model.name,
    capabilities: {
      temperature: true,
      reasoning: model.reasoning && Object.keys(model.variants).length > 0,
      attachment: true,
      toolcall: true,
      input: {
        text: true,
        audio: false,
        image: true,
        video: false,
        pdf: false,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: false,
    },
    cost: ZERO_COST,
    limit: modelLimits(model),
    status: "active" as const,
    options: { includeUsage: true },
    headers: {},
    release_date: "",
    variants: buildRuntimeVariants(model),
  };
}

function modelLimits(model: CursorModel): { context: number; output: number } {
  return {
    context:
      model.contextWindow > 0 ? model.contextWindow : 200_000,
    output: model.maxTokens > 0 ? model.maxTokens : 64_000,
  };
}

function buildRuntimeVariants(
  model: CursorModel,
): Record<string, Record<string, string>> {
  return Object.fromEntries(
    Object.keys(model.variants).map((key) => [
      key,
      { [CURSOR_VARIANT_OPTION]: key },
    ]),
  );
}

function buildConfigVariants(
  model: CursorModel,
): Record<string, Record<string, string | boolean>> {
  const variants: Record<string, Record<string, string | boolean>> =
    buildRuntimeVariants(model);
  for (const key of GENERATED_VARIANT_KEYS) {
    if (!(key in variants)) variants[key] = { disabled: true };
  }
  return variants;
}

function buildConfigModelEntries(
  models: readonly CursorModel[],
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    models.map((model) => [
      model.id,
      {
        name: model.name,
        // Keep OpenCode's generic variants disabled; Cursor variants are exact.
        reasoning: false,
        attachment: true,
        tool_call: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        capabilities: {
          tools: true,
          input: ["text", "image"],
          output: ["text"],
        },
        cost: ZERO_COST,
        limit: modelLimits(model),
        options: { includeUsage: true },
        variants: buildConfigVariants(model),
      },
    ]),
  );
}

function ensureCursorProviderConfig(
  config: unknown,
  models: readonly CursorModel[],
): () => void {
  if (!isRecord(config)) return () => {};
  const cfg = config as ConfigRecord;
  cfg.provider ??= {};
  const existing = isRecord(cfg.provider[CURSOR_PROVIDER_ID])
    ? cfg.provider[CURSOR_PROVIDER_ID]
    : {};
  const existingOptions = isRecord(existing.options) ? existing.options : {};
  const existingModels = isRecord(existing.models) ? existing.models : {};
  const placeholderOnly =
    models.length === 1 && isLoginPlaceholderModel(models[0]);
  const loginUrl = placeholderOnly
    ? extractLoginUrlFromPlaceholder(models[0]?.name)
    : undefined;
  const seededName = placeholderOnly
    ? loginUrl
      ? "Cursor - open the login URL shown in the model list (browser OAuth, not an API key)"
      : "Cursor (sign in required - browser OAuth, not an API key)"
    : "Cursor";

  const seededModels = buildConfigModelEntries(models);
  const seededPlaceholder =
    placeholderOnly && !Object.hasOwn(existingModels, "default")
      ? seededModels.default
      : undefined;
  cfg.provider[CURSOR_PROVIDER_ID] = {
    ...existing,
    name:
      typeof existing.name === "string" && existing.name.trim()
        ? existing.name
        : seededName,
    npm: existing.npm ?? OPENAI_COMPATIBLE_NPM,
    options: {
      baseURL: CURSOR_LOGICAL_BASE_URL,
      includeUsage: true,
      ...existingOptions,
    },
    models: {
      ...seededModels,
      ...existingModels,
    },
  };

  if (!seededPlaceholder) return () => {};
  return () => {
    const configured = cfg.provider?.[CURSOR_PROVIDER_ID];
    if (!isRecord(configured) || !isRecord(configured.models)) return;
    if (configured.models.default === seededPlaceholder) {
      delete configured.models.default;
    }
  };
}

function extractLoginUrlFromPlaceholder(
  name: string | undefined,
): string | undefined {
  if (!name) return undefined;
  const marker = "OPEN THIS URL TO LOGIN → ";
  if (!name.startsWith(marker)) return undefined;
  const url = name.slice(marker.length).trim();
  return url.startsWith("http") ? url : undefined;
}

async function resolveLoggedOutPlaceholder(): Promise<CursorModel[]> {
  try {
    const pending = await startCursorBrowserLogin();
    return loginPlaceholderModels(pending.url);
  } catch {
    log.warn("[opencode-cursor] Failed to start Cursor browser login");
    return LOGIN_PLACEHOLDER_MODELS;
  }
}

async function resolveConfigModels(
  getAccessToken: (getAuth: AuthGetter) => Promise<string>,
  transport: UnifiedChatTransport,
): Promise<CursorModel[]> {
  const stored = readStoredCursorAuth();
  if (!stored) return resolveLoggedOutPlaceholder();

  let token: string;
  try {
    token = await getAccessToken(async () => readStoredCursorAuth());
  } catch (error) {
    log.warn(
      error instanceof RefreshTokenInvalidError
        ? "[opencode-cursor] Stored Cursor refresh was rejected"
        : "[opencode-cursor] Stored Cursor authentication is unavailable",
    );
    return resolveLoggedOutPlaceholder();
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    try {
      const models = await withTimeout(
        getCursorModels(token, transport),
        15_000,
      );
      if (models.length > 0) return models;
    } catch {
      log.warn(
        `[opencode-cursor] Cursor model discovery failed for config (attempt ${attempt + 1}/3)`,
      );
    }
  }

  log.warn(
    "[opencode-cursor] Cursor model discovery returned no supported models",
  );
  return resolveLoggedOutPlaceholder();
}

function readStoredCursorAuth(): CursorOAuthAuth | undefined {
  try {
    const base =
      process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
    const authPath = join(base, "opencode", "auth.json");
    const data: unknown = JSON.parse(readFileSync(authPath, "utf8"));
    if (!isRecord(data)) return undefined;
    const cursor = data[CURSOR_PROVIDER_ID];
    return isCursorOAuthAuth(cursor) ? cursor : undefined;
  } catch {
    return undefined;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export default CursorAuthPlugin;
