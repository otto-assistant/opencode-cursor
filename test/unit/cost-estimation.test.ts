import { describe, expect, test } from "bun:test";
import { DEFAULT_COST, estimateModelCost } from "../../src/index";

describe("estimateModelCost", () => {
  test("returns exact match cost when model id exists in table", () => {
    expect(estimateModelCost("gpt-5.2")).toEqual({
      input: 1.75,
      output: 14,
      cache: { read: 0.175, write: 0 },
    });
  });

  test("matches claude opus family pattern", () => {
    expect(estimateModelCost("claude-next-opus-enterprise")).toEqual({
      input: 5,
      output: 25,
      cache: { read: 0.5, write: 6.25 },
    });
  });

  test("matches stripped suffix variants", () => {
    expect(estimateModelCost("claude-4.6-opus-high")).toEqual({
      input: 5,
      output: 25,
      cache: { read: 0.5, write: 6.25 },
    });
    expect(estimateModelCost("gpt-5.4-medium")).toEqual({
      input: 2.5,
      output: 15,
      cache: { read: 0.25, write: 0 },
    });
  });

  test("falls back to DEFAULT_COST for unknown models", () => {
    expect(estimateModelCost("totally-unknown-model")).toEqual(DEFAULT_COST);
  });

  test("covers major model families", () => {
    expect(estimateModelCost("claude-4.5-sonnet")).toEqual({
      input: 3,
      output: 15,
      cache: { read: 0.3, write: 3.75 },
    });
    expect(estimateModelCost("gpt-5.4-nano")).toEqual({
      input: 0.2,
      output: 1.25,
      cache: { read: 0.02, write: 0 },
    });
    expect(estimateModelCost("gemini-3-pro-image")).toEqual({
      input: 2,
      output: 12,
      cache: { read: 0.2, write: 0 },
    });
    expect(estimateModelCost("grok-code-fast-1")).toEqual({
      input: 2,
      output: 6,
      cache: { read: 0.2, write: 0 },
    });
    expect(estimateModelCost("kimi-k2.5")).toEqual({
      input: 0.6,
      output: 3,
      cache: { read: 0.1, write: 0 },
    });
    expect(estimateModelCost("composer-2-fast")).toEqual({
      input: 1.5,
      output: 7.5,
      cache: { read: 0.2, write: 0 },
    });
  });
});
