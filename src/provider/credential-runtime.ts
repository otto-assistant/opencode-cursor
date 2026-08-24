import type { PluginInput } from "@opencode-ai/plugin";
import { RefreshTokenInvalidError } from "../auth.js";
import {
  createAccessTokenProvider,
  ensureValidAccessToken,
  isCursorOAuthCredential,
} from "../auth/credential-manager.js";
import {
  getCursorModels,
  LOGIN_PLACEHOLDER_MODELS,
  type CursorModel,
} from "../models.js";
import { startProxy } from "../proxy.js";
import { CURSOR_PROVIDER_ID } from "../shared/constants.js";
import { log } from "../shared/log.js";
import { buildCursorProviderModels } from "./model-descriptor.js";

export async function loadCursorRuntime(
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
  if (!isCursorOAuthCredential(auth)) return undefined;

  const persist = async (cred: {
    type: "oauth";
    access?: string;
    refresh: string;
    expires: number;
  }) => {
    await input.client.auth.set({
      path: { id: CURSOR_PROVIDER_ID },
      body: {
        type: "oauth",
        refresh: cred.refresh,
        access: cred.access ?? "",
        expires: cred.expires,
      },
    });
  };

  // Refresh failures must NOT throw out of provider/auth hooks, or
  // OpenCode's provider.list() fails entirely. Return undefined so Cursor is
  // simply treated as unavailable until the user re-runs login.
  let accessToken: string | undefined;
  try {
    accessToken = await ensureValidAccessToken({ auth, persist });
  } catch (err) {
    const permanent = err instanceof RefreshTokenInvalidError;
    const summary = err instanceof Error ? err.message : String(err);
    log.error(
      `[opencode-cursor] Cursor token refresh ${permanent ? "rejected (re-login required)" : "failed (transient)"}: ${summary}`,
    );
    return undefined;
  }
  if (!accessToken) return undefined;

  // Never advertise a fake catalog through the provider hook.
  const discovered = await getCursorModels(accessToken);
  const models =
    discovered.length > 0 ? discovered : LOGIN_PLACEHOLDER_MODELS;
  onModels?.(models);

  // startProxy() is idempotent: if the proxy is already running it returns
  // immediately with the bound (ephemeral) port.
  const port = await startProxy(
    createAccessTokenProvider(getAuth, persist),
    models,
  );

  const providerModels = buildCursorProviderModels(models, port);
  if (provider) {
    (provider as { models?: Record<string, unknown> }).models = providerModels;
  }

  return { port, providerModels };
}
