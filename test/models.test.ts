import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import {
  clearModelCache,
  filterSupportedCursorModels,
  getCursorModels,
  normalizeAvailableModels,
  resolveCursorModelSelection,
  type CursorModel,
} from "../src/models";
import type { CursorModelSelection } from "../src/model-selection";
import type {
  CursorTransport,
  CursorTransportRequest,
  CursorTransportResponse,
} from "../src/unified-chat-transport";

function selection(publicId: string, maxMode = false): CursorModelSelection {
  return {
    publicId,
    modelId: `${publicId}-server`,
    displayName: publicId,
    parameters: [],
    maxMode,
  };
}

function model(
  id: string,
  defaultSelection: CursorModelSelection = selection(id),
  variants: CursorModel["variants"] = {},
): CursorModel {
  return {
    id,
    name: id,
    reasoning: Object.keys(variants).length > 0,
    contextWindow: 200_000,
    maxTokens: 64_000,
    defaultSelection,
    variants,
  };
}

function response(status: number, value: unknown): CursorTransportResponse {
  const body = new TextEncoder().encode(JSON.stringify(value));
  return {
    status,
    headers: new Headers({ "content-type": "application/json" }),
    trailers: Promise.resolve(new Headers()),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    }),
  };
}

function enumParameter(id: string, values: readonly string[]) {
  return {
    id,
    parameterType: {
      enumParameter: { values: values.map((value) => ({ value })) },
    },
  };
}

function parameterizedGptModel(contextValues = ["272k", "1m"]) {
  const efforts = ["high", "none", "medium", "xhigh", "low", "max"];
  const variants = [
    ...efforts.map((reasoning) => ({
      parameterValues: [
        { id: "context", value: "272k" },
        { id: "reasoning", value: reasoning },
      ],
      legacySlug: `gpt-5.6-sol-${reasoning}`,
      isDefaultNonMaxConfig: reasoning === "medium",
      isMaxMode: false,
    })),
    ...["high", "medium"].map((reasoning) => ({
      parameterValues: [
        { id: "context", value: "1m" },
        { id: "reasoning", value: reasoning },
      ],
      legacySlug: `gpt-5.6-sol-${reasoning}`,
      isDefaultMaxConfig: reasoning === "high",
      isMaxMode: true,
    })),
    {
      parameterValues: [
        { id: "context", value: "272k" },
        { id: "reasoning", value: "turbo" },
      ],
      legacySlug: "gpt-5.6-sol-turbo",
      isMaxMode: false,
    },
  ];
  return {
    name: "gpt-5.6-sol",
    clientDisplayName: "GPT-5.6 Sol",
    serverModelName: "gpt-5.6-sol",
    parameterDefinitions: [
      enumParameter("context", contextValues),
      enumParameter("reasoning", [...efforts, "turbo"]),
    ],
    variants,
  };
}

describe("Cursor model policy", () => {
  test("retains supported families and promotes the first supported non-max variant", () => {
    const high = selection("claude-promoted-high");
    const max = selection("claude-promoted-max", true);
    const filtered = filterSupportedCursorModels([
      model("claude-basic"),
      model("gpt-basic"),
      model("gemini-basic"),
      model("claude-promoted", max, { max, high }),
      model("claude-max-only", selection("claude-max-only", true)),
      model("gemini-3-pro-image"),
      model("gemini-imagegen"),
      model("gpt-realtime"),
      model("default"),
      model("composer-2"),
      model("grok-basic"),
    ]);

    expect(filtered.map((item) => item.id)).toEqual([
      "claude-basic",
      "gpt-basic",
      "gemini-basic",
      "claude-promoted",
    ]);
    expect(filtered.at(-1)?.defaultSelection).toEqual(high);
    expect(filtered.at(-1)?.variants).toEqual({ high });
  });

  test("omits models marked deprecated by AvailableModels", () => {
    const normalized = normalizeAvailableModels([
      { name: "claude-current", variants: [] },
      { name: "gpt-deprecated", isDeprecated: true, variants: [] },
      { name: "gemini-deprecated", deprecated: true, variants: [] },
    ]);

    expect(normalized.map((item) => item.id)).toEqual(["claude-current"]);
  });

  test("groups only returned parameter combinations in canonical variant order", () => {
    const normalized = normalizeAvailableModels([parameterizedGptModel()]);

    expect(normalized.map((item) => item.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-sol-1m",
    ]);
    const standard = normalized[0]!;
    expect(Object.keys(standard.variants)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(standard.defaultSelection.publicId).toBe("gpt-5.6-sol-medium");
    expect(standard.contextWindow).toBe(272_000);

    const extended = normalized[1]!;
    expect(Object.keys(extended.variants)).toEqual(["medium", "high"]);
    expect(extended.defaultSelection.publicId).toBe("gpt-5.6-sol-high");
    expect(extended.contextWindow).toBe(1_000_000);
    expect(
      normalized.some((item) =>
        Object.values(item.variants).some(
          (variant) => variant.publicId === "gpt-5.6-sol-turbo",
        ),
      ),
    ).toBe(false);

    const supported = filterSupportedCursorModels(normalized);
    expect(supported.map((item) => item.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-sol-1m",
    ]);
    expect(supported[0]?.defaultSelection.maxMode).toBe(false);
    expect(supported[1]?.defaultSelection.maxMode).toBe(true);
    expect(supported[0]?.variants.medium?.publicId).toBe("gpt-5.6-sol-medium");
    expect(supported[1]?.variants.medium?.publicId).toBe("gpt-5.6-sol-medium");
    expect(supported[0]?.variants.medium?.maxMode).toBe(false);
    expect(supported[1]?.variants.medium?.maxMode).toBe(true);
  });

  test("keeps the base ID non-max and exposes only exact 1m max groups", () => {
    const reversed = filterSupportedCursorModels(
      normalizeAvailableModels([parameterizedGptModel(["1m", "272k"])]),
    );
    expect(reversed.map((item) => item.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-sol-1m",
    ]);
    expect(reversed[0]?.contextWindow).toBe(272_000);
    expect(reversed[0]?.defaultSelection.maxMode).toBe(false);
    expect(reversed[1]?.contextWindow).toBe(1_000_000);
    expect(reversed[1]?.defaultSelection.maxMode).toBe(true);

    const qualified = filterSupportedCursorModels(normalizeAvailableModels([
      {
        name: "gpt-max-only",
        parameterDefinitions: [
          enumParameter("context", ["1m"]),
          enumParameter("reasoning", ["medium"]),
        ],
        variants: [{
          legacySlug: "gpt-max-only-medium",
          isDefaultMaxConfig: true,
          isMaxMode: true,
          parameterValues: [
            { id: "context", value: "1m" },
            { id: "reasoning", value: "medium" },
          ],
        }],
      },
      {
        name: "gpt-max-missing-context",
        variants: [{
          legacySlug: "gpt-max-missing-context-medium",
          isDefaultMaxConfig: true,
          isMaxMode: true,
          parameterValues: [{ id: "reasoning", value: "medium" }],
        }],
      },
      {
        name: "gpt-two",
        parameterDefinitions: [
          enumParameter("context", ["272k", "2m"]),
          enumParameter("reasoning", ["medium"]),
        ],
        variants: [
          {
            legacySlug: "gpt-two-medium",
            isDefaultNonMaxConfig: true,
            isMaxMode: false,
            parameterValues: [
              { id: "context", value: "272k" },
              { id: "reasoning", value: "medium" },
            ],
          },
          {
            legacySlug: "gpt-two-medium",
            isDefaultMaxConfig: true,
            isMaxMode: true,
            parameterValues: [
              { id: "context", value: "2m" },
              { id: "reasoning", value: "medium" },
            ],
          },
        ],
      },
    ]));
    expect(qualified.map((item) => item.id)).toEqual([
      "gpt-max-only-1m",
      "gpt-two",
    ]);
  });

  test("omits parameterized variants without unique literal public IDs", () => {
    const normalized = normalizeAvailableModels([
      {
        name: "claude-missing-slug",
        variants: [
          { parameterValues: [] },
          {
            parameterValues: [{ id: "reasoning", value: "high" }],
          },
        ],
      },
      {
        name: "gpt-duplicate-slug",
        variants: [
          {
            legacySlug: "gpt-shared",
            parameterValues: [{ id: "reasoning", value: "low" }],
          },
          {
            legacySlug: "gpt-shared",
            parameterValues: [{ id: "reasoning", value: "medium" }],
          },
          {
            legacySlug: "gpt-unique-high",
            parameterValues: [{ id: "reasoning", value: "high" }],
          },
        ],
      },
    ]);

    expect(normalized.map((item) => item.id)).toEqual([
      "gpt-duplicate-slug",
    ]);
    expect(normalized[0]?.defaultSelection.publicId).toBe("gpt-unique-high");
    expect(normalized[0]?.variants).toEqual({
      high: expect.objectContaining({ publicId: "gpt-unique-high" }),
    });

    const crossModelDuplicates = filterSupportedCursorModels(
      normalizeAvailableModels([
        {
          name: "claude-alias-a",
          variants: [{ legacySlug: "claude-shared", parameterValues: [] }],
        },
        {
          name: "claude-alias-b",
          variants: [{ legacySlug: "claude-shared", parameterValues: [] }],
        },
      ]),
    );
    expect(crossModelDuplicates).toEqual([]);
  });

  test("omits duplicate catalog records that disagree on routing", () => {
    const normalized = normalizeAvailableModels([
      {
        name: "claude-collided",
        serverModelName: "claude-server-a",
        variants: [],
      },
      {
        name: "claude-collided",
        serverModelName: "claude-server-b",
        variants: [],
      },
    ]);

    expect(normalized).toEqual([]);
  });

  test("resolves variants strictly", () => {
    const high = selection("claude-strict-high");
    const strictModel = model(
      "claude-strict",
      selection("claude-strict"),
      { high },
    );

    expect(
      resolveCursorModelSelection([strictModel], strictModel.id, "HIGH"),
    ).toEqual(high);
    expect(
      resolveCursorModelSelection([strictModel], strictModel.id, "unknown"),
    ).toBeUndefined();
    expect(
      resolveCursorModelSelection([strictModel], "unknown", undefined),
    ).toBeUndefined();
  });

  test("discovers through AvailableModels, isolates token caches, and never caches failures", async () => {
    const requestCounts = new Map<string, number>();
    const transport: CursorTransport = {
      async request(request: CursorTransportRequest) {
        requestCounts.set(
          request.accessToken,
          (requestCounts.get(request.accessToken) ?? 0) + 1,
        );
        expect(request.path).toBe("/aiserver.v1.AiService/AvailableModels");
        expect(request.contentType).toBe("application/json");
        expect(JSON.parse(new TextDecoder().decode(request.body))).toEqual({
          isNightly: false,
          excludeMaxNamedModels: true,
          additionalModelNames: [],
          useModelParameters: true,
          useReactModelPicker: true,
        });
        if (request.accessToken === "failure-token") {
          return response(503, { error: "synthetic failure" });
        }
        if (request.accessToken === "token-b") {
          return response(200, {
            models: [
              { name: "gemini-token-b", variants: [] },
              { name: "grok-token-b", variants: [] },
            ],
          });
        }
        return response(200, {
          models: [
            { name: "claude-token-a", variants: [] },
            { name: "composer-2", variants: [] },
          ],
        });
      },
    };

    clearModelCache();
    try {
      const first = await getCursorModels("token-a", transport);
      const cached = await getCursorModels("token-a", transport);
      const secondToken = await getCursorModels("token-b", transport);
      const failed = await getCursorModels("failure-token", transport);
      const retried = await getCursorModels("failure-token", transport);

      expect(first.map((item) => item.id)).toEqual(["claude-token-a"]);
      expect(cached).toBe(first);
      expect(secondToken.map((item) => item.id)).toEqual(["gemini-token-b"]);
      expect(failed).toEqual([]);
      expect(retried).toEqual([]);
      expect(requestCounts).toEqual(
        new Map([
          ["token-a", 1],
          ["token-b", 1],
          ["failure-token", 2],
        ]),
      );
    } finally {
      clearModelCache();
    }
  });

  test("decompresses gzip AvailableModels responses", async () => {
    const body = gzipSync(JSON.stringify({
      models: [{ name: "claude-gzip", variants: [] }],
    }));
    const transport: CursorTransport = {
      async request() {
        return {
          status: 200,
          headers: new Headers({
            "content-encoding": "gzip",
            "content-type": "application/json",
          }),
          trailers: Promise.resolve(new Headers()),
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(body);
              controller.close();
            },
          }),
        };
      },
    };

    clearModelCache();
    try {
      const models = await getCursorModels("gzip-token", transport);
      expect(models.map((item) => item.id)).toEqual(["claude-gzip"]);
    } finally {
      clearModelCache();
    }
  });
});
