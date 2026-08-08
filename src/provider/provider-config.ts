import {
  isLoginPlaceholderModel,
  type CursorModel,
} from "../models.js";
import {
  CURSOR_PROVIDER_ID,
  OPENAI_COMPATIBLE_NPM,
} from "../shared/constants.js";
import { buildConfigModelEntries } from "./model-descriptor.js";

/**
 * Ensure OpenCode has a concrete `cursor` provider declaration in its config so
 * the provider and its models appear in the model menu. Existing user-defined
 * fields and models are preserved; only missing pieces are filled in.
 *
 * `baseURL` is the live proxy URL (ephemeral port). OpenCode 1.15.x reads the
 * provider base URL from this static config, so callers must start the proxy
 * first and pass the real URL — never a placeholder fixed port.
 */
export function ensureCursorProviderConfig(
  config: unknown,
  models: CursorModel[],
  baseURL: string,
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
      baseURL,
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

function extractLoginUrlFromPlaceholder(
  name: string | undefined,
): string | undefined {
  if (!name) return undefined;
  const marker = "OPEN THIS URL TO LOGIN → ";
  if (!name.startsWith(marker)) return undefined;
  const url = name.slice(marker.length).trim();
  return url.startsWith("http") ? url : undefined;
}
