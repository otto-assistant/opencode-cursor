import { describe, expect, test } from "bun:test";
import { createCursorRuntime, type CursorRuntimeServices } from "../src/opencode/runtime";
import type { CursorCatalogState } from "../src/opencode/catalog";
import type { CursorModel } from "../src/model-selection";

function services(
  overrides: Partial<CursorRuntimeServices> = {},
): CursorRuntimeServices {
  return {
    registerIntegration: async () => ({ dispose: async () => {} }),
    registerCatalog: async () => ({ dispose: async () => {} }),
    registerLanguage: async () => ({ dispose: async () => {} }),
    createAccessTokenProvider: () => async () => "token",
    resolveCredential: async () => undefined,
    getModels: async () => [],
    startTransport: () => {},
    stopTransport: () => {},
    resetLogin: () => {},
    clearModelCache: () => {},
    sleep: async () => {},
    ...overrides,
  };
}

function context(events: unknown[] = []) {
  return {
    catalog: { reload: async () => {} },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield event;
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      }),
    },
  };
}

const model: CursorModel = {
  id: "composer-test",
  name: "Composer Test",
  reasoning: false,
  contextWindow: 100_000,
  maxTokens: 8_000,
  defaultSelection: {
    publicId: "composer-test",
    modelId: "composer-test",
    displayName: "Composer Test",
    parameters: [],
    maxMode: false,
  },
  variants: {},
};

describe("OpenCode V2 runtime lifecycle", () => {
  test("disposes native provider resources when the plugin is unloaded", async () => {
    const disposed: string[] = [];
    let resets = 0;
    let transportStarts = 0;
    const setup = createCursorRuntime(services({
      registerIntegration: async () => ({
        dispose: async () => { disposed.push("integration"); },
      }),
      registerLanguage: async () => ({
        dispose: async () => { disposed.push("language"); },
      }),
      registerCatalog: async () => ({
        dispose: async () => { disposed.push("catalog"); },
      }),
      startTransport: () => { transportStarts += 1; },
      stopTransport: () => { disposed.push("transport"); },
      resetLogin: () => { resets += 1; },
      clearModelCache: () => { resets += 1; },
    }));

    const cleanup = await setup(context() as never);
    await cleanup?.();

    expect(transportStarts).toBe(1);
    expect(disposed).toEqual(["catalog", "language", "transport", "integration"]);
    expect(resets).toBe(2);
  });

  test("reloads the live catalog when the Cursor connection changes", async () => {
    let state: CursorCatalogState | undefined;
    let discoveries = 0;
    let reloads = 0;
    const setup = createCursorRuntime(services({
      resolveCredential: async () => ({ access: "token" }) as never,
      getModels: async () => {
        discoveries += 1;
        return [model];
      },
      registerCatalog: async (_context, value) => {
        state = value;
        return { dispose: async () => {} };
      },
      clearModelCache: () => {},
    }));
    const ctx = context([{
      type: "integration.connection.updated",
      data: { integrationID: "cursor" },
    }]);
    ctx.catalog.reload = async () => { reloads += 1; };

    const cleanup = await setup(ctx as never);
    for (let attempt = 0; attempt < 20 && discoveries < 2; attempt++) await Bun.sleep(5);

    expect(discoveries).toBe(2);
    expect(reloads).toBe(1);
    expect(state?.models).toEqual([model]);
    await cleanup?.();
  });

  test("rolls back native registrations when catalog setup fails", async () => {
    const disposed: string[] = [];
    const setup = createCursorRuntime(services({
      registerIntegration: async () => ({
        dispose: async () => { disposed.push("integration"); },
      }),
      registerLanguage: async () => ({
        dispose: async () => { disposed.push("language"); },
      }),
      registerCatalog: async () => {
        throw new Error("catalog registration failed");
      },
    }));

    await expect(setup(context() as never)).rejects.toThrow("catalog registration failed");
    expect(disposed).toEqual(["language", "integration"]);
  });

  test("continues handling connection events after a catalog reload failure", async () => {
    let reloads = 0;
    const setup = createCursorRuntime(services({
      resolveCredential: async () => ({ access: "token" }) as never,
      getModels: async () => [model],
    }));
    const ctx = context([
      { type: "integration.connection.updated", data: { integrationID: "cursor" } },
      { type: "integration.connection.updated", data: { integrationID: "cursor" } },
    ]);
    ctx.catalog.reload = async () => {
      reloads += 1;
      if (reloads === 1) throw new Error("temporary reload failure");
    };

    const cleanup = await setup(ctx as never);
    for (let attempt = 0; attempt < 20 && reloads < 2; attempt++) await Bun.sleep(5);

    expect(reloads).toBe(2);
    await cleanup?.();
  });
});
