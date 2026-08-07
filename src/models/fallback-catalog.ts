import { literalCursorModelSelection } from "../model-selection.js";
import type { CursorModel } from "./types.js";

export const FALLBACK_MODELS: CursorModel[] = [
  // Composer models
  flatModel("composer-1", "Composer 1", true, 200_000, 64_000),
  flatModel("composer-1.5", "Composer 1.5", true, 200_000, 64_000),
  // Claude models
  flatModel("claude-4.6-opus-high", "Claude 4.6 Opus", true, 200_000, 128_000),
  flatModel("claude-4.6-sonnet-medium", "Claude 4.6 Sonnet", true, 200_000, 64_000),
  flatModel("claude-4.5-sonnet", "Claude 4.5 Sonnet", true, 200_000, 64_000),
  // GPT models
  flatModel("gpt-5.4-medium", "GPT-5.4", true, 272_000, 128_000),
  flatModel("gpt-5.2", "GPT-5.2", true, 400_000, 128_000),
  flatModel("gpt-5.2-codex", "GPT-5.2 Codex", true, 400_000, 128_000),
  flatModel("gpt-5.3-codex", "GPT-5.3 Codex", true, 400_000, 128_000),
  flatModel("gpt-5.3-codex-spark-preview", "GPT-5.3 Codex Spark", true, 128_000, 128_000),
  // Other models
  flatModel("gemini-3.1-pro", "Gemini 3.1 Pro", true, 1_000_000, 64_000),
  flatModel("grok-code-fast-1", "Grok Code Fast 1", false, 256_000, 64_000),
  flatModel("grok-4-fast-reasoning", "Grok 4 Fast Reasoning", true, 200_000, 64_000),
];

/**
 * Minimal catalog seeded while logged out. OpenCode removes providers that
 * have zero models from `provider.list()`, which hides Cursor in OpenChamber's
 * provider settings and blocks the OAuth connect button. A single placeholder
 * keeps the provider visible without advertising a fake model catalog.
 *
 * When a live browser login URL is available (OpenChamber does not always
 * surface plugin OAuth methods), embed it in the model name so the user can
 * copy/open it — same flow as `opencode auth login`.
 */
export const LOGIN_PLACEHOLDER_MODELS: CursorModel[] = [
  flatModel(
    "default",
    "Cursor (authorize to load models)",
    false,
    200_000,
    64_000,
  ),
];

export function loginPlaceholderModels(loginUrl?: string): CursorModel[] {
  if (!loginUrl) return LOGIN_PLACEHOLDER_MODELS;
  return [
    flatModel(
      "default",
      `OPEN THIS URL TO LOGIN → ${loginUrl}`,
      false,
      200_000,
      64_000,
    ),
  ];
}

export function isLoginPlaceholderModel(model: CursorModel | undefined): boolean {
  if (!model || model.id !== "default") return false;
  return (
    model.name === LOGIN_PLACEHOLDER_MODELS[0]!.name ||
    model.name.startsWith("OPEN THIS URL TO LOGIN")
  );
}

export function flatModel(
  id: string,
  name: string,
  reasoning: boolean,
  contextWindow: number,
  maxTokens: number,
): CursorModel {
  return {
    id,
    name,
    reasoning,
    contextWindow,
    maxTokens,
    defaultSelection: literalCursorModelSelection(id),
    variants: {},
  };
}
