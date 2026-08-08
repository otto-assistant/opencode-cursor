/**
 * OpenCode Cursor Auth Plugin
 *
 * Enables using Cursor models (Claude, GPT, etc.) inside OpenCode via:
 * 1. Browser-based OAuth login to Cursor
 * 2. Local proxy translating OpenAI format → Cursor gRPC protocol
 */
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import {
  startCursorBrowserLogin,
  getPendingCursorLogin,
  waitForCursorBrowserLogin,
} from "./auth-login.js";
import {
  CURSOR_SELECTION_HEADER,
  encodeCursorModelSelection,
} from "./model-selection.js";
import { clearModelCache, resolveCursorModelSelection, type CursorModel } from "./models.js";
import { resolveConfigModels } from "./provider/config-models.js";
import { loadCursorRuntime } from "./provider/credential-runtime.js";
import { ensureCursorProviderConfig } from "./provider/provider-config.js";
import { getCursorProxyBaseUrl, startProxy } from "./proxy.js";
import {
  CURSOR_PROVIDER_ID,
  CURSOR_VARIANT_OPTION,
} from "./shared/constants.js";

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

  /**
   * Bind the local proxy early (ephemeral port) so the static provider
   * `options.baseURL` OpenCode reads from config points at a live listener.
   * Auth/token wiring is upgraded later by `loadCursorRuntime`.
   */
  async function ensureProxyForConfig(
    models: CursorModel[],
  ): Promise<string> {
    const existing = getCursorProxyBaseUrl();
    if (existing) return existing;
    const port = await startProxy(async () => {
      throw new Error("Cursor proxy is not authenticated yet");
    }, models);
    return `http://localhost:${port}/v1`;
  }

  return {
    // Newer OpenCode releases build the model catalog from statically declared
    // `config.provider.<id>` entries. Seed a concrete `cursor` provider so it
    // always appears; dynamic hooks refine connection details at runtime.
    async config(config) {
      const models = await resolveConfigModels();
      rememberModels(models);
      const baseURL = await ensureProxyForConfig(models);
      ensureCursorProviderConfig(config, models, baseURL);
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
      // Route the selected Cursor variant through a private local header —
      // do not leak OpenCode reasoning defaults or our marker into the SDK body.
      delete output.options.reasoningEffort;
      delete output.options[CURSOR_VARIANT_OPTION];
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
            stripAuthorizationHeader(init);
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

/** Remove Authorization so the local proxy does not forward a dummy API key. */
function stripAuthorizationHeader(init?: RequestInit): void {
  if (!init?.headers) return;
  if (init.headers instanceof Headers) {
    init.headers.delete("authorization");
  } else if (Array.isArray(init.headers)) {
    init.headers = init.headers.filter(
      ([key]) => key.toLowerCase() !== "authorization",
    );
  } else {
    delete (init.headers as Record<string, string>)["authorization"];
    delete (init.headers as Record<string, string>)["Authorization"];
  }
}

export default CursorAuthPlugin;
