/** Shared plugin constants — single source of truth. */

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Math.floor(Number(value));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const CURSOR_PROVIDER_ID = "cursor";
export const DEFAULT_MODEL_ID = "default";
export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";
export const CURSOR_VARIANT_OPTION = "cursorVariant";

export const DEFAULT_CONTEXT_WINDOW = positiveInteger(
  process.env.OPENCODE_CURSOR_DEFAULT_CONTEXT_WINDOW,
  200_000,
);
export const DEFAULT_MAX_TOKENS = positiveInteger(
  process.env.OPENCODE_CURSOR_DEFAULT_MAX_TOKENS,
  64_000,
);

export const GENERATED_VARIANT_KEYS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
