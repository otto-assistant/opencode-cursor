import type { PluginInput } from "@opencode-ai/plugin";
import {
  refreshCursorToken,
  RefreshTokenInvalidError,
} from "../auth.js";
import { isCursorOAuthCredential } from "../auth/types.js";
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
    if (!isCursorOAuthCredential(currentAuth)) {
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
