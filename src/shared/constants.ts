/** Shared plugin constants — single source of truth. */

export const CURSOR_PROVIDER_ID = "cursor";
export const DEFAULT_MODEL_ID = "default";
export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";
export const CURSOR_VARIANT_OPTION = "cursorVariant";

export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_MAX_TOKENS = 64_000;

export const GENERATED_VARIANT_KEYS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
