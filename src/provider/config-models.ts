import {
  readStoredCursorAuth,
  writeStoredCursorAuth,
} from "../auth/opencode-auth-store.js";
import { ensureValidAccessToken } from "../auth/credential-manager.js";
import { startCursorBrowserLogin } from "../auth-login.js";
import {
  getCursorModels,
  loginPlaceholderModels,
  LOGIN_PLACEHOLDER_MODELS,
  type CursorModel,
} from "../models.js";
import { log } from "../shared/log.js";

/** Reject a promise if it does not settle within `ms` milliseconds. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
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

/**
 * Resolve the model list used to seed the static provider config. Prefers the
 * full set discovered from Cursor (using the stored OAuth access token) so the
 * whole catalog shows up in the menu.
 *
 * When logged out — or when a stored token cannot discover models — seeds a
 * single login placeholder. OpenCode drops providers with zero models from
 * `provider.list()`, which would hide Cursor in OpenChamber. We intentionally
 * never invent a fake offline catalog for the provider UI.
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

export async function resolveConfigModels(): Promise<CursorModel[]> {
  const stored = readStoredCursorAuth();
  if (!stored) return resolveLoggedOutPlaceholder();

  let accessToken: string | undefined;
  try {
    accessToken = await ensureValidAccessToken({
      auth: stored,
      persist: writeStoredCursorAuth,
    });
  } catch (err) {
    const summary = err instanceof Error ? err.message : String(err);
    log.warn(
      `[opencode-cursor] config model discovery refresh failed: ${summary}`,
    );
    return resolveLoggedOutPlaceholder();
  }
  if (!accessToken) return resolveLoggedOutPlaceholder();

  // Transient h2-bridge / Cursor API hiccups at plugin load used to fall
  // straight to the login placeholder. Retry discovery briefly before giving up.
  let discovered: CursorModel[] = [];
  for (let attempt = 0; attempt < 3 && discovered.length === 0; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1_000 * attempt));
    }
    try {
      discovered = await withTimeout(
        getCursorModels(accessToken),
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
