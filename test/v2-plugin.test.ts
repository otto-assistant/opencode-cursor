import { describe, expect, test } from "bun:test";
import plugin from "../src/index";

describe("OpenCode V2 plugin contract", () => {
  test("exports a uniquely identified setup plugin", () => {
    expect(plugin.id).toBe("opencode.provider.cursor");
    expect(typeof plugin.setup).toBe("function");
  });
});
