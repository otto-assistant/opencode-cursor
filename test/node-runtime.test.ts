import { describe, expect, test } from "bun:test";
import { findNodeExecutable } from "../src/node-runtime";

describe("Node runtime discovery", () => {
  test("prefers the explicit bridge runtime override", () => {
    expect(
      findNodeExecutable(
        { OPENCODE_CURSOR_NODE_PATH: "/custom/node" },
        () => "/path/node",
        () => "/shell/node",
      ),
    ).toBe("/custom/node");
  });

  test("falls back from service PATH to the login shell", () => {
    expect(
      findNodeExecutable(
        {},
        () => undefined,
        () => "/home/user/.nvm/node",
      ),
    ).toBe("/home/user/.nvm/node");
  });
});
