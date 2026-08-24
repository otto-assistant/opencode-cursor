import { Plugin } from "@opencode-ai/plugin";
import {
  setupCursorRuntime,
} from "./opencode/runtime.js";

export const CursorAuthPlugin = Plugin.define({
  id: "opencode.provider.cursor",
  setup: setupCursorRuntime,
});

export default CursorAuthPlugin;
