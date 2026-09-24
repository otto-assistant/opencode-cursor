import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";

// The suite runs under Bun, so process.execPath intentionally launches a fresh
// Bun process that can import the TypeScript module without a build step.
const readFallbackLimits = (environment: NodeJS.ProcessEnv) => JSON.parse(
  execFileSync(
    process.execPath,
    [
      "-e",
      "import('./src/shared/constants.ts').then(({ DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS }) => console.log(JSON.stringify([DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS])))",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: environment,
    },
  ),
) as [number, number];

describe("shared constants", () => {
  test("uses positive integer fallback-limit overrides", () => {
    expect(readFallbackLimits({
      ...process.env,
      OPENCODE_CURSOR_DEFAULT_CONTEXT_WINDOW: "123456",
      OPENCODE_CURSOR_DEFAULT_MAX_TOKENS: "7890",
    })).toEqual([123456, 7890]);

    expect(readFallbackLimits({
      ...process.env,
      OPENCODE_CURSOR_DEFAULT_CONTEXT_WINDOW: "invalid",
      OPENCODE_CURSOR_DEFAULT_MAX_TOKENS: "-1",
    })).toEqual([200000, 64000]);

    expect(readFallbackLimits({
      ...process.env,
      OPENCODE_CURSOR_DEFAULT_CONTEXT_WINDOW: "0.5",
      OPENCODE_CURSOR_DEFAULT_MAX_TOKENS: "7890.9",
    })).toEqual([200000, 7890]);
  });
});
