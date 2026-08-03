/**
 * OpenCode Cursor Auth Plugin
 *
 * Enables using Cursor models (Claude, GPT, etc.) inside OpenCode via:
 * 1. Browser-based OAuth login to Cursor
 * 2. Local proxy translating OpenAI format → Cursor gRPC protocol
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import {
  refreshCursorToken,
  RefreshTokenInvalidError,
} from "./auth.js";
import {
  getCursorModels,
  clearModelCache,
  LOGIN_PLACEHOLDER_MODELS,
  loginPlaceholderModels,
  isLoginPlaceholderModel,
  resolveCursorModelSelection,
  type CursorModel,
} from "./models.js";
import {
  startProxy,
  getCursorProxyBaseUrl,
} from "./proxy.js";
import {
  CURSOR_SELECTION_HEADER,
  encodeCursorModelSelection,
} from "./model-selection.js";
import {
  startCursorBrowserLogin,
  getPendingCursorLogin,
  waitForCursorBrowserLogin,
} from "./auth-login.js";
import { log } from "./log.js";

const CURSOR_PROVIDER_ID = "cursor";
const DEFAULT_MODEL_ID = "default";
const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";
const CURSOR_VARIANT_OPTION = "cursorVariant";
const GENERATED_VARIANT_KEYS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

// Base URL OpenCode uses for the statically-declared provider. It points at
// the proxy's fixed port so requests reach the local proxy (OpenCode resolves
// the base URL from static config, not from the auth loader).
const CURSOR_BASE_URL = getCursorProxyBaseUrl();

type CursorOAuthAuth = {
  type: "oauth";
  access?: string;
  refresh: string;
  expires: number;
};

async function loadCursorRuntime(
  input: PluginInput,
  getAuth: () => Promise<unknown>,
  provider?: unknown,
  onModels?: (models: CursorModel[]) => void,
): Promise<
  | {
      port: number;
      providerModels: Record<string, any>;
    }
  | undefined
> {
  const auth = await getAuth();
  if (!isCursorOAuthAuth(auth)) return undefined;

  // Ensure we have a valid access token, refreshing if expired.
  // Refresh failures must NOT throw out of provider/auth hooks, or
  // OpenCode's provider.list() fails entirely and every Discord /model and
  // /login call surfaces "Failed to fetch providers". Return undefined so
  // Cursor is simply treated as unavailable until the user re-runs login.
  let accessToken = auth.access;
  if (!accessToken || auth.expires < Date.now()) {
    try {
      const refreshed = await refreshCursorToken(auth.refresh);
      await input.client.auth.set({
        path: { id: CURSOR_PROVIDER_ID },
        body: {
          type: "oauth",
          refresh: refreshed.refresh,
          access: refreshed.access,
          expires: refreshed.expires,
        },
      });
      accessToken = refreshed.access;
    } catch (err) {
      const permanent = err instanceof RefreshTokenInvalidError;
      const summary = err instanceof Error ? err.message : String(err);
      log.error(
        `[opencode-cursor] Cursor token refresh ${permanent ? "rejected (re-login required)" : "failed (transient)"}: ${summary}`,
      );
      return undefined;
    }
  }

  // Never advertise the hardcoded FALLBACK catalog through the provider hook —
  // OpenChamber's provider page would show ~14 stale models instead of the live
  // Cursor catalog. If discovery fails, keep a login placeholder until retry.
  const discovered = await getCursorModels(accessToken, {
    allowFallback: false,
  });
  const models =
    discovered.length > 0 ? discovered : LOGIN_PLACEHOLDER_MODELS;
  onModels?.(models);

  // startProxy() is idempotent: if the proxy is already running on the same
  // port it returns immediately. If it was stopped, it binds a new random port.
  const port = await startProxy(async () => {
    const currentAuth = await getAuth();
    if (!isCursorOAuthAuth(currentAuth)) {
      throw new Error("Cursor auth not configured");
    }

    if (!currentAuth.access || currentAuth.expires < Date.now()) {
      const refreshed = await refreshCursorToken(currentAuth.refresh);
      await input.client.auth.set({
        path: { id: CURSOR_PROVIDER_ID },
        body: {
          type: "oauth",
          refresh: refreshed.refresh,
          access: refreshed.access,
          expires: refreshed.expires,
        },
      });
      return refreshed.access;
    }

    return currentAuth.access;
  }, models);

  const providerModels = buildCursorProviderModels(models, port);
  if (provider) {
    (provider as any).models = providerModels;
  }

  return { port, providerModels };
}

function isCursorOAuthAuth(auth: unknown): auth is CursorOAuthAuth {
  return (
    !!auth &&
    typeof auth === "object" &&
    (auth as { type?: unknown }).type === "oauth" &&
    typeof (auth as { refresh?: unknown }).refresh === "string" &&
    typeof (auth as { expires?: unknown }).expires === "number"
  );
}

/**
 * OpenCode plugin that provides Cursor authentication and model access.
 * Register in opencode.json: { "plugin": ["@otto-assistant/opencode-cursor-oauth"] }
 */
export const CursorAuthPlugin: Plugin = async (
  input: PluginInput,
): Promise<Hooks> => {
  let modelCatalog: CursorModel[] = [];
  const rememberModels = (models: CursorModel[]) => {
    modelCatalog = models;
  };

  return {
    // Newer OpenCode releases (1.15.x) build the model catalog/menu only from
    // statically declared `config.provider.<id>` entries (or models.dev) and no
    // longer surface a plugin's dynamic `provider.models()` hook there. Seed a
    // concrete `cursor` provider here so it always appears, without clobbering
    // any user-defined overrides. The dynamic hook + auth loader below still
    // refine connection details and models at runtime. When logged out, seed a
    // login placeholder model so OpenCode does not drop the provider (empty
    // model maps are removed from provider.list, which hides Cursor in
    // OpenChamber). After OAuth, discovery replaces the placeholder.
    async config(config) {
      const models = await resolveConfigModels();
      rememberModels(models);
      ensureCursorProviderConfig(config, models);
    },

    "chat.headers": async (hookInput, output) => {
      if (hookInput.model.providerID !== CURSOR_PROVIDER_ID) return;
      const messageModel = hookInput.message.model as typeof hookInput.message.model & {
        variant?: unknown;
      };
      const variant =
        typeof messageModel.variant === "string" ? messageModel.variant : undefined;
      const selected = resolveCursorModelSelection(
        modelCatalog,
        hookInput.model.id,
        variant,
      );
      if (selected) {
        output.headers[CURSOR_SELECTION_HEADER] =
          encodeCursorModelSelection(selected);
      }
    },

    "chat.params": async (hookInput, output) => {
      if (hookInput.model.providerID !== CURSOR_PROVIDER_ID) return;
      // The selected Cursor variant is routed through a private local header.
      // Do not let OpenCode's generic reasoning defaults or our marker leak to
      // the OpenAI-compatible SDK request body.
      delete output.options.reasoningEffort;
      delete output.options[CURSOR_VARIANT_OPTION];
    },

    "experimental.session.compacting": async (hookInput, output) => {
      // Discourage tool hallucination during session compaction.  Some models
      // (particularly Claude) emit tool calls (bash, read, etc.) even when no
      // tool definitions are provided.  The proxy fix in handleExecMessage
      // rejects such calls at the transport level, but adding explicit
      // instructions here further reduces the chance the model attempts them.
      output.context.push(
        "IMPORTANT: Do NOT call any tools. Only produce a summary as text. No tool calls are allowed.",
      );
      // After compact, OpenCode continues with a synthetic "Continue if you have
      // next steps…" turn. Summaries that keep "fill context / re-read every
      // large file / read AGENTS.md" as Active work cause an infinite refill loop.
      // Also: if concrete facts are omitted from DONE, the next turn cannot
      // finish without re-reading — which we forbid — so it stalls or thrashs.
      output.context.push(
        [
          "CRITICAL for the next turn after compaction:",
          "Structure the summary with DONE (concrete findings already discovered) and REMAINING (only unfinished user deliverables).",
          "PRESERVE VERBATIM in DONE: routes, URLs, query strings, flag names, redirects, refresh endpoints, commands, error codes, and any CONFIRMED/authoritative header values.",
          "If those concrete values are missing from DONE, the next turn cannot finish — copy them now.",
          "Do NOT list context-filling checklists as remaining work.",
          "Do NOT tell the next turn to re-read AGENTS.md, encyclopedias, repeat-*.md, big.json, or other large docs already examined.",
          "Do NOT say the next turn must follow a mandatory mass-Read checklist.",
          "If the user objective is answerable from DONE findings, REMAINING must be only: deliver the final answer (no more discovery).",
        ].join(" "),
      );

      // Pull already-seen CONFIRMED / authoritative facts from the session and
      // force them into the summary context so the next turn can finish without
      // re-reading the corpus.
      try {
        const result = await input.client.session.messages({
          path: { id: hookInput.sessionID },
        });
        const payload = (result as { data?: unknown }).data ?? result;
        // Unescape JSON string noise so patterns like "/login" are not cut at "n"
        // by a mistaken [^\\n] character class.
        const blob = JSON.stringify(payload ?? "")
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\")
          .slice(0, 900_000);
        const facts: string[] = [];
        for (const match of blob.matchAll(
          /#\s*CONFIRMED[^\n]*\n(?:[^\n]*\n){0,10}/gi,
        )) {
          const block = match[0].trim();
          if (block.length > 40 && !facts.includes(block)) facts.push(block);
          if (facts.length >= 4) break;
        }
        for (const match of blob.matchAll(
          /(?:Primary route|Redirect|Flags|Refresh|Canonical access|Recovery|Deep links?):\s*[^\n]{3,220}/gi,
        )) {
          const line = match[0].trim();
          if (line.length > 12 && !facts.includes(line)) facts.push(line);
          if (facts.length >= 12) break;
        }
        if (facts.length > 0) {
          output.context.push(
            [
              "MUST copy these already-seen CONFIRMED/authoritative facts VERBATIM into DONE.",
              "Do not paraphrase away the concrete values:",
              ...facts.slice(0, 12).map((f, i) => `${i + 1}. ${f}`),
            ].join("\n"),
          );
          log.info(
            `[opencode-cursor] compacting injected ${Math.min(facts.length, 12)} verbatim facts session=${hookInput.sessionID}`,
          );
        }
      } catch (err) {
        const summary = err instanceof Error ? err.message : String(err);
        log.warn(
          `[opencode-cursor] compacting fact extraction failed: ${summary}`,
        );
      }
    },

    provider: {
      id: CURSOR_PROVIDER_ID,
      async models(provider, ctx) {
        const runtime = await loadCursorRuntime(
          input,
          async () => ctx.auth,
          provider,
          rememberModels,
        );
        return runtime?.providerModels ?? {};
      },
    },

    auth: {
      provider: CURSOR_PROVIDER_ID,

      async loader(getAuth, provider) {
        const runtime = await loadCursorRuntime(
          input,
          getAuth,
          provider,
          rememberModels,
        );
        if (!runtime) return {};

        return {
          baseURL: `http://localhost:${runtime.port}/v1`,
          apiKey: "cursor-proxy",
          async fetch(
            requestInput: RequestInfo | URL,
            init?: RequestInit,
          ) {
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("authorization");
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(
                  ([key]) => key.toLowerCase() !== "authorization",
                );
              } else {
                delete (init.headers as Record<string, string>)[
                  "authorization"
                ];
                delete (init.headers as Record<string, string>)[
                  "Authorization"
                ];
              }
            }

            return fetch(requestInput, init);
          },
        };
      },

      methods: [
        {
          type: "oauth",
          label: "Login with Cursor",
          async authorize() {
            // Reuse the headless browser login started by the config hook so
            // OpenChamber / CLI show one URL and share one poll session.
            let pending = getPendingCursorLogin();
            if (!pending || pending.completed) {
              pending = await startCursorBrowserLogin();
            }

            return {
              url: pending.url,
              instructions:
                "Open the URL below in your browser to authorize Cursor (same as `opencode auth login`). After you approve access, return here and click Complete — the live model list will load automatically. No API key is required.",
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
  };
};

function buildCursorProviderModels(
  models: CursorModel[],
  port: number,
): Record<string, any> {
  const providerModels = Object.fromEntries(
    models.map((model) => [model.id, buildProviderModel(model, model.id, port)]),
  );
  const defaultModel = selectDefaultCursorModel(models);
  if (defaultModel && !(DEFAULT_MODEL_ID in providerModels)) {
    providerModels[DEFAULT_MODEL_ID] = buildProviderModel(
      defaultModel,
      DEFAULT_MODEL_ID,
      port,
    );
  }
  return providerModels;
}

function selectDefaultCursorModel(models: CursorModel[]): CursorModel | undefined {
  return (
    models.find((model) => model.id === "composer-2") ??
    models.find((model) => model.id === "composer-2-fast") ??
    models.find((model) => model.id === "composer-1.5") ??
    models.find((model) => model.id.startsWith("composer-")) ??
    models[0]
  );
}

function buildProviderModel(
  model: CursorModel,
  id: string,
  port: number,
): Record<string, any> {
  const contextWindow =
    model.contextWindow > 0 ? model.contextWindow : 200_000;
  const maxTokens = model.maxTokens > 0 ? model.maxTokens : 64_000;
  return {
    id,
    providerID: CURSOR_PROVIDER_ID,
    api: {
      // Send the catalog/alias id literally. For the "default" alias this means
      // Cursor receives "default" and performs its own server-side model
      // auto-selection and rate-limit routing. Pre-resolving it to a concrete
      // model here would defeat that (see proxy.resolveProxyModelId).
      id,
      url: `http://localhost:${port}/v1`,
      npm: "@ai-sdk/openai-compatible",
    },
    name: id === DEFAULT_MODEL_ID ? `Default (${model.name})` : model.name,
    // Cursor agent models accept image attachments (vision). OpenCode gates
    // file/image parts client-side on these flags — leaving image:false made
    // every Cursor model report "does not support Image input".
    capabilities: {
      temperature: true,
      reasoning:
        id === DEFAULT_MODEL_ID
          ? false
          : model.reasoning && Object.keys(model.variants).length > 0,
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
    modalities: {
      input: ["text", "image"],
      output: ["text"],
    },
    cost: estimateModelCost(model.id),
    limit: {
      context: contextWindow,
      output: maxTokens,
    },
    status: "active" as const,
    options: {
      includeUsage: true,
    },
    headers: {},
    release_date: "",
    variants: id === DEFAULT_MODEL_ID ? {} : buildRuntimeVariants(model),
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

/**
 * Ensure OpenCode has a concrete `cursor` provider declaration in its config so
 * the provider and its models appear in the model menu. Existing user-defined
 * fields and models are preserved; only missing pieces are filled in.
 */
function ensureCursorProviderConfig(
  config: unknown,
  models: CursorModel[],
): void {
  if (!config || typeof config !== "object") return;
  const cfg = config as { provider?: Record<string, any> };
  cfg.provider ??= {};

  const existing = cfg.provider[CURSOR_PROVIDER_ID] ?? {};
  const existingOptions =
    existing.options && typeof existing.options === "object"
      ? existing.options
      : {};
  const existingModels =
    existing.models && typeof existing.models === "object"
      ? existing.models
      : {};

  const placeholderOnly = isLoginPlaceholderCatalog(models);
  const loginUrl = placeholderOnly
    ? extractLoginUrlFromPlaceholder(models[0]?.name)
    : undefined;
  const seededName = placeholderOnly
    ? loginUrl
      ? "Cursor — open the login URL shown in the model list (browser OAuth, not an API key)"
      : "Cursor (sign in required — browser OAuth, not an API key)"
    : "Cursor";
  const providerName =
    typeof existing.name === "string" && existing.name.trim()
      ? existing.name
      : seededName;

  cfg.provider[CURSOR_PROVIDER_ID] = {
    ...existing,
    name: providerName,
    npm: existing.npm ?? OPENAI_COMPATIBLE_NPM,
    options: {
      baseURL: CURSOR_BASE_URL,
      // Ensure OpenAI-compatible streams surface usage chunks to OpenCode's
      // context meter (AI SDK includeUsage / stream_options.include_usage).
      includeUsage: true,
      ...existingOptions,
    },
    // User-declared model entries win over the seeded defaults.
    models: {
      ...buildConfigModelEntries(models),
      ...existingModels,
    },
  };
}

function isLoginPlaceholderCatalog(models: CursorModel[]): boolean {
  return models.length === 1 && isLoginPlaceholderModel(models[0]);
}

function extractLoginUrlFromPlaceholder(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const marker = "OPEN THIS URL TO LOGIN → ";
  if (!name.startsWith(marker)) return undefined;
  const url = name.slice(marker.length).trim();
  return url.startsWith("http") ? url : undefined;
}

/**
 * Resolve the model list used to seed the static provider config. Prefers the
 * full set discovered from Cursor (using the stored OAuth access token) so the
 * whole catalog shows up in the menu.
 *
 * When logged out — or when a stored token cannot discover models — seeds a
 * single login placeholder. OpenCode drops providers with zero models from
 * `provider.list()`, which would hide Cursor in OpenChamber. We intentionally
 * never seed the hardcoded FALLBACK_MODELS catalog into the provider UI: that
 * advertised ~14 stale models as if they were the live Cursor list (~50).
 *
 * Never throws.
 */
async function resolveLoggedOutPlaceholder(): Promise<CursorModel[]> {
  // OpenChamber's provider detail page often skips plugin OAuth methods and
  // shows a misleading API-key field. Start the same browser OAuth as
  // `opencode auth login` and embed the URL in the placeholder model name.
  try {
    const pending = await startCursorBrowserLogin();
    return loginPlaceholderModels(pending.url);
  } catch (err) {
    const summary = err instanceof Error ? err.message : String(err);
    log.warn(`[opencode-cursor] failed to start browser login: ${summary}`);
    return LOGIN_PLACEHOLDER_MODELS;
  }
}

async function resolveConfigModels(): Promise<CursorModel[]> {
  const stored = readStoredCursorAuth();
  if (!stored) return resolveLoggedOutPlaceholder();

  let accessToken = stored.access;
  if (!accessToken || stored.expires < Date.now()) {
    try {
      const refreshed = await refreshCursorToken(stored.refresh);
      writeStoredCursorAuth({
        type: "oauth",
        access: refreshed.access,
        refresh: refreshed.refresh,
        expires: refreshed.expires,
      });
      accessToken = refreshed.access;
    } catch (err) {
      const summary = err instanceof Error ? err.message : String(err);
      log.warn(
        `[opencode-cursor] config model discovery refresh failed: ${summary}`,
      );
      return resolveLoggedOutPlaceholder();
    }
  }

  try {
    // Allow enough time for the HTTP/2 bridge + AvailableModels round-trip.
    // The previous 4s budget often fell through to the hardcoded fallback list.
    const discovered = await withTimeout(
      getCursorModels(accessToken, { allowFallback: false }),
      15_000,
    );
    if (discovered.length > 0) {
      log.info(
        `[opencode-cursor] discovered ${discovered.length} Cursor models for provider config`,
      );
      return discovered;
    }
    log.warn(
      "[opencode-cursor] Cursor model discovery returned no models; seeding login placeholder",
    );
    return resolveLoggedOutPlaceholder();
  } catch (err) {
    const summary = err instanceof Error ? err.message : String(err);
    log.warn(
      `[opencode-cursor] Cursor model discovery failed for config: ${summary}`,
    );
    return resolveLoggedOutPlaceholder();
  }
}

type StoredCursorAuth = {
  type: "oauth";
  access?: string;
  refresh: string;
  expires: number;
};

function getOpencodeAuthPath(): string {
  const base =
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "opencode", "auth.json");
}

/**
 * Best-effort read of the stored Cursor OAuth entry from OpenCode's auth store.
 * Returns undefined if missing or malformed. Expired access tokens are still
 * returned when a refresh token is present so callers can refresh.
 */
function readStoredCursorAuth(): StoredCursorAuth | undefined {
  try {
    const data = JSON.parse(readFileSync(getOpencodeAuthPath(), "utf8"));
    const cursor = data?.[CURSOR_PROVIDER_ID];
    if (!cursor || cursor.type !== "oauth") return undefined;
    if (typeof cursor.refresh !== "string" || !cursor.refresh) return undefined;
    if (typeof cursor.expires !== "number") return undefined;
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

function writeStoredCursorAuth(auth: StoredCursorAuth): void {
  try {
    const authPath = getOpencodeAuthPath();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(readFileSync(authPath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      data = {};
    }
    data[CURSOR_PROVIDER_ID] = {
      type: "oauth",
      access: auth.access,
      refresh: auth.refresh,
      expires: auth.expires,
    };
    writeFileSync(authPath, `${JSON.stringify(data, null, 2)}\n`);
  } catch (err) {
    const summary = err instanceof Error ? err.message : String(err);
    log.warn(`[opencode-cursor] failed to persist refreshed Cursor auth: ${summary}`);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function buildConfigModelEntries(
  models: CursorModel[],
): Record<string, Record<string, any>> {
  const entries: Record<string, Record<string, any>> = {};
  for (const model of models) {
    const contextWindow =
      model.contextWindow > 0 ? model.contextWindow : 200_000;
    const maxTokens = model.maxTokens > 0 ? model.maxTokens : 64_000;
    entries[model.id] = {
      name: model.name,
      // OpenCode prepends generic low/medium/high variants for reasoning-capable
      // OpenAI-compatible models before merging custom variants. Marking this
      // config descriptor non-reasoning keeps our explicit Cursor variant map
      // authoritative, including its canonical presentation order. Cursor
      // reasoning output and routing are handled by the local proxy.
      reasoning: false,
      tool_call: true,
      // Required for OpenCode's static config path: without modalities.input
      // including "image", attachments are stripped before they reach the proxy.
      modalities: {
        input: ["text", "image"],
        output: ["text"],
      },
      capabilities: {
        tools: true,
        input: ["text", "image"],
        output: ["text"],
      },
      cost: estimateModelCost(model.id),
      limit: {
        context: contextWindow,
        output: maxTokens,
      },
      options: {
        includeUsage: true,
      },
      variants: buildConfigVariants(model),
    };
  }

  // Seed a "default" entry so OpenCode versions that build the model menu from
  // static config still expose Cursor's auto-routing. The entry key ("default")
  // is sent upstream verbatim, so Cursor selects/routes the model itself.
  const defaultModel = selectDefaultCursorModel(models);
  if (defaultModel && !(DEFAULT_MODEL_ID in entries)) {
    const contextWindow =
      defaultModel.contextWindow > 0 ? defaultModel.contextWindow : 200_000;
    const maxTokens = defaultModel.maxTokens > 0 ? defaultModel.maxTokens : 64_000;
    entries[DEFAULT_MODEL_ID] = {
      name: `Default (${defaultModel.name})`,
      reasoning: false,
      tool_call: true,
      modalities: {
        input: ["text", "image"],
        output: ["text"],
      },
      capabilities: {
        tools: true,
        input: ["text", "image"],
        output: ["text"],
      },
      cost: estimateModelCost(defaultModel.id),
      limit: {
        context: contextWindow,
        output: maxTokens,
      },
      options: {
        includeUsage: true,
      },
      variants: Object.fromEntries(
        GENERATED_VARIANT_KEYS.map((key) => [key, { disabled: true }]),
      ),
    };
  }
  return entries;
}

interface ModelCost {
  input: number;
  output: number;
  cache: { read: number; write: number };
}

// $/M token rates from cursor.com/docs/models-and-pricing
const MODEL_COST_TABLE: Record<string, ModelCost> = {
  // Anthropic
  "claude-4-sonnet":         { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
  "claude-4-sonnet-1m":      { input: 6, output: 22.5, cache: { read: 0.6, write: 7.5 } },
  "claude-4.5-haiku":        { input: 1, output: 5, cache: { read: 0.1, write: 1.25 } },
  "claude-4.5-opus":         { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
  "claude-4.5-sonnet":       { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
  "claude-4.6-opus":         { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
  "claude-4.6-opus-fast":    { input: 30, output: 150, cache: { read: 3, write: 37.5 } },
  "claude-4.6-sonnet":       { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },

  // Cursor
  "composer-1":              { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } },
  "composer-1.5":            { input: 3.5, output: 17.5, cache: { read: 0.35, write: 0 } },
  "composer-2":              { input: 0.5, output: 2.5, cache: { read: 0.2, write: 0 } },
  "composer-2-fast":         { input: 1.5, output: 7.5, cache: { read: 0.2, write: 0 } },

  // Google
  "gemini-2.5-flash":        { input: 0.3, output: 2.5, cache: { read: 0.03, write: 0 } },
  "gemini-3-flash":          { input: 0.5, output: 3, cache: { read: 0.05, write: 0 } },
  "gemini-3-pro":            { input: 2, output: 12, cache: { read: 0.2, write: 0 } },
  "gemini-3-pro-image":      { input: 2, output: 12, cache: { read: 0.2, write: 0 } },
  "gemini-3.1-pro":          { input: 2, output: 12, cache: { read: 0.2, write: 0 } },

  // OpenAI
  "gpt-5":                   { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } },
  "gpt-5-fast":              { input: 2.5, output: 20, cache: { read: 0.25, write: 0 } },
  "gpt-5-mini":              { input: 0.25, output: 2, cache: { read: 0.025, write: 0 } },
  "gpt-5-codex":             { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } },
  "gpt-5.1-codex":           { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } },
  "gpt-5.1-codex-max":       { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } },
  "gpt-5.1-codex-mini":      { input: 0.25, output: 2, cache: { read: 0.025, write: 0 } },
  "gpt-5.2":                 { input: 1.75, output: 14, cache: { read: 0.175, write: 0 } },
  "gpt-5.2-codex":           { input: 1.75, output: 14, cache: { read: 0.175, write: 0 } },
  "gpt-5.3-codex":           { input: 1.75, output: 14, cache: { read: 0.175, write: 0 } },
  "gpt-5.4":                 { input: 2.5, output: 15, cache: { read: 0.25, write: 0 } },
  "gpt-5.4-mini":            { input: 0.75, output: 4.5, cache: { read: 0.075, write: 0 } },
  "gpt-5.4-nano":            { input: 0.2, output: 1.25, cache: { read: 0.02, write: 0 } },

  // xAI
  "grok-4-5":                { input: 2, output: 6, cache: { read: 0.2, write: 0 } },
  "grok-4.20":               { input: 2, output: 6, cache: { read: 0.2, write: 0 } },
  "grok-4-fast-reasoning":   { input: 2, output: 6, cache: { read: 0.2, write: 0 } },
  "grok-4-0709":             { input: 2, output: 6, cache: { read: 0.2, write: 0 } },

  // Moonshot
  "kimi-k2.5":               { input: 0.6, output: 3, cache: { read: 0.1, write: 0 } },
};

// Most-specific first
const MODEL_COST_PATTERNS: Array<{ match: (id: string) => boolean; cost: ModelCost }> = [
  { match: (id) => /claude.*opus.*fast/i.test(id),   cost: MODEL_COST_TABLE["claude-4.6-opus-fast"]! },
  { match: (id) => /claude.*opus/i.test(id),         cost: MODEL_COST_TABLE["claude-4.6-opus"]! },
  { match: (id) => /claude.*haiku/i.test(id),        cost: MODEL_COST_TABLE["claude-4.5-haiku"]! },
  { match: (id) => /claude.*sonnet/i.test(id),       cost: MODEL_COST_TABLE["claude-4.6-sonnet"]! },
  { match: (id) => /claude/i.test(id),               cost: MODEL_COST_TABLE["claude-4.6-sonnet"]! },
  { match: (id) => /composer-?2/i.test(id),          cost: MODEL_COST_TABLE["composer-2"]! },
  { match: (id) => /composer-?1\.5/i.test(id),      cost: MODEL_COST_TABLE["composer-1.5"]! },
  { match: (id) => /composer/i.test(id),             cost: MODEL_COST_TABLE["composer-1"]! },
  { match: (id) => /gpt-5\.4.*nano/i.test(id),      cost: MODEL_COST_TABLE["gpt-5.4-nano"]! },
  { match: (id) => /gpt-5\.4.*mini/i.test(id),      cost: MODEL_COST_TABLE["gpt-5.4-mini"]! },
  { match: (id) => /gpt-5\.4/i.test(id),            cost: MODEL_COST_TABLE["gpt-5.4"]! },
  { match: (id) => /gpt-5\.3/i.test(id),            cost: MODEL_COST_TABLE["gpt-5.3-codex"]! },
  { match: (id) => /gpt-5\.2/i.test(id),            cost: MODEL_COST_TABLE["gpt-5.2"]! },
  { match: (id) => /gpt-5\.1.*mini/i.test(id),      cost: MODEL_COST_TABLE["gpt-5.1-codex-mini"]! },
  { match: (id) => /gpt-5\.1/i.test(id),            cost: MODEL_COST_TABLE["gpt-5.1-codex"]! },
  { match: (id) => /gpt-5.*mini/i.test(id),          cost: MODEL_COST_TABLE["gpt-5-mini"]! },
  { match: (id) => /gpt-5.*fast/i.test(id),          cost: MODEL_COST_TABLE["gpt-5-fast"]! },
  { match: (id) => /gpt-5/i.test(id),                cost: MODEL_COST_TABLE["gpt-5"]! },
  { match: (id) => /gemini.*3\.1/i.test(id),        cost: MODEL_COST_TABLE["gemini-3.1-pro"]! },
  { match: (id) => /gemini.*3.*flash/i.test(id),     cost: MODEL_COST_TABLE["gemini-3-flash"]! },
  { match: (id) => /gemini.*3/i.test(id),            cost: MODEL_COST_TABLE["gemini-3-pro"]! },
  { match: (id) => /gemini.*flash/i.test(id),        cost: MODEL_COST_TABLE["gemini-2.5-flash"]! },
  { match: (id) => /gemini/i.test(id),               cost: MODEL_COST_TABLE["gemini-3.1-pro"]! },
  { match: (id) => /grok/i.test(id),                 cost: MODEL_COST_TABLE["grok-4.20"]! },
  { match: (id) => /kimi/i.test(id),                 cost: MODEL_COST_TABLE["kimi-k2.5"]! },
];

const DEFAULT_COST: ModelCost = { input: 3, output: 15, cache: { read: 0.3, write: 0 } };

function estimateModelCost(modelId: string): ModelCost {
  const normalized = modelId.toLowerCase();
  const exact = MODEL_COST_TABLE[normalized];
  if (exact) return exact;

  const stripped = normalized.replace(/-(high|medium|low|preview|thinking|spark-preview)$/g, "");
  const strippedMatch = MODEL_COST_TABLE[stripped];
  if (strippedMatch) return strippedMatch;

  return MODEL_COST_PATTERNS.find((p) => p.match(normalized))?.cost ?? DEFAULT_COST;
}

export default CursorAuthPlugin;
