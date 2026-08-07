import type { CursorModelSelection } from "../model-selection.js";

export interface CursorModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  defaultSelection: CursorModelSelection;
  variants: Record<string, CursorModelSelection>;
}
