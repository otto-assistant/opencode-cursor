import {
  readStoredCursorAuth,
  writeStoredCursorAuth,
} from "../auth/opencode-auth-store.js";
import { startCursorBrowserLogin } from "../auth-login.js";
import { refreshCursorToken } from "../auth.js";
import {
  getCursorModels,
  loginPlaceholderModels,
  LOGIN_PLACEHOLDER_MODELS,
  type CursorModel,
} from "../models.js";
import { log } from "../shared/log.js";
import { withTimeout } from "../shared/timeout.js";

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
export async function resolveLoggedOutPlaceholder(): Promise<CursorModel[]> {
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

export async function resolveConfigModels(): Promise<CursorModel[]> {
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

  // Transient h2-bridge / Cursor API hiccups at plugin load used to fall
  // straight to the login placeholder, leaving the provider with zero real
  // models until the next restart (every model request fails with
  // "Model not found"). Retry discovery briefly before giving up.
  let discovered: CursorModel[] = [];
  for (let attempt = 0; attempt < 3 && discovered.length === 0; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1_000 * attempt));
    }
    try {
      // Allow enough time for the HTTP/2 bridge + AvailableModels round-trip.
      // The previous 4s budget often fell through to the hardcoded fallback list.
      discovered = await withTimeout(
        getCursorModels(accessToken, { allowFallback: false }),
        15_000,
      );
    } catch (err) {
      const summary = err instanceof Error ? err.message : String(err);
      log.warn(
        `[opencode-cursor] Cursor model discovery failed (attempt ${attempt + 1}/3) for config: ${summary}`,
      );
    }
  }
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
}
