/**
 * OpenCode Cursor Auth Plugin
 *
 * Enables using Cursor models (Claude, GPT, etc.) inside OpenCode via:
 * 1. Browser-based OAuth login to Cursor
 * 2. Local proxy translating OpenAI format → Cursor gRPC protocol
 */
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import {
  generateCursorAuthParams,
  getTokenExpiry,
  pollCursorAuth,
  refreshCursorToken,
} from "./auth";
import { getCursorModels } from "./models";
import { startProxy, stopProxy } from "./proxy";

const CURSOR_PROVIDER_ID = "cursor";

/**
 * OpenCode plugin that provides Cursor authentication and model access.
 * Register in opencode.json: { "plugin": ["opencode-cursor-oauth"] }
 */
export const CursorAuthPlugin: Plugin = async (
  input: PluginInput,
): Promise<Hooks> => {
  return {
    auth: {
      provider: CURSOR_PROVIDER_ID,

      async loader(getAuth, provider) {
        const auth = await getAuth();
        if (!auth || auth.type !== "oauth") return {};

        // Start local proxy if not already running
        const port = await startProxy(async () => {
          const currentAuth = await getAuth();
          if (currentAuth.type !== "oauth") {
            throw new Error("Cursor auth not configured");
          }

          // Refresh token if expired
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
        });

        // Discover models and inject into provider
        if (provider) {
          if (!provider.models) (provider as any).models = {};
          try {
            const models = await getCursorModels(auth.access);
            for (const model of models) {
              if (provider.models[model.id]) continue;
              // Cast needed: OpenCode's internal Model type requires fields
              // (interleaved, release_date, variants) not in the plugin SDK type.
              provider.models[model.id] = {
                id: model.id,
                providerID: CURSOR_PROVIDER_ID,
                api: {
                  id: model.id,
                  url: `http://localhost:${port}/v1`,
                  npm: "@ai-sdk/openai-compatible",
                },
                name: model.name,
                capabilities: {
                  temperature: true,
                  reasoning: model.reasoning,
                  attachment: false,
                  toolcall: true,
                  input: {
                    text: true,
                    audio: false,
                    image: false,
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
                cost: {
                  input: 0,
                  output: 0,
                  cache: { read: 0, write: 0 },
                },
                limit: {
                  context: model.contextWindow,
                  output: model.maxTokens,
                },
                status: "active" as const,
                options: {},
                headers: {},
                release_date: "",
                variants: {},
              } as any;
            }
          } catch {
            // Model discovery failed — proxy still works with direct model IDs
          }

          // Zero out costs for all Cursor models (included with subscription)
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
              cache: { read: 0, write: 0 },
            };
          }
        }

        return {
          baseURL: `http://localhost:${port}/v1`,
          apiKey: "cursor-proxy",
          async fetch(
            requestInput: RequestInfo | URL,
            init?: RequestInit,
          ) {
            // Strip any dummy auth headers — proxy handles auth internally
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("authorization");
                init.headers.delete("Authorization");
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
            const { verifier, uuid, loginUrl } =
              await generateCursorAuthParams();

            return {
              url: loginUrl,
              instructions:
                "Complete login in your browser. This window will close automatically.",
              method: "auto" as const,
              async callback() {
                const { accessToken, refreshToken } = await pollCursorAuth(
                  uuid,
                  verifier,
                );

                return {
                  type: "success" as const,
                  refresh: refreshToken,
                  access: accessToken,
                  expires: getTokenExpiry(accessToken),
                };
              },
            };
          },
        },
      ],
    },
  };
};

export default CursorAuthPlugin;
