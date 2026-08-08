import {
  literalCursorModelSelection,
  type CursorModel,
} from "../model-selection.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
} from "../shared/constants.js";
/**
 * Minimal catalog seeded while logged out. OpenCode removes providers that
 * have zero models from `provider.list()`, which hides Cursor in OpenChamber.
 * A single placeholder keeps the provider visible without advertising a fake
 * catalog. When a live browser login URL is available, embed it in the name.
 */
export const LOGIN_PLACEHOLDER_MODELS: CursorModel[] = [
  flatModel("default", "Cursor (authorize to load models)", false),
];

export function loginPlaceholderModels(loginUrl?: string): CursorModel[] {
  if (!loginUrl) return LOGIN_PLACEHOLDER_MODELS;
  return [
    flatModel(
      "default",
      `OPEN THIS URL TO LOGIN → ${loginUrl}`,
      false,
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

function flatModel(
  id: string,
  name: string,
  reasoning: boolean,
  contextWindow = DEFAULT_CONTEXT_WINDOW,
  maxTokens = DEFAULT_MAX_TOKENS,
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
