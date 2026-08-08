/**
 * Focused unit checks for pure helpers extracted during the refactor.
 * Invoked from smoke.ts so `bun run test` covers them.
 */
import {
  assert,
  assertEqual,
  assertArrayEqual,
} from "../helpers/assert";

export async function runExtractedHelperUnitTests(): Promise<void> {
  console.log("[test] Testing extracted pure helpers...");

  const { parseMessages, extractImagesFromContent } = await import("../../src/proxy");
  const {
    isTitleGenerationRequest,
    isSummaryGenerationRequest,
    hasUserSteerAfterTools,
    buildInterruptSteerUserText,
    truncateToolResultForCursor,
    buildPostToolBridgeLossContinuation,
  } = await import("../../src/proxy");
  const { estimateModelCost } = await import("../../src/provider/pricing");
  const { withTimeout } = await import("../../src/provider/config-models");
  const { isCursorOAuthCredential } = await import(
    "../../src/auth/credential-manager"
  );

  // Regeneration path must reattach images from the pending user content
  // (regression: content was cleared before extractImagesFromContent ran).
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const regenerated = parseMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        { type: "image_url", image_url: png },
      ],
    },
    { role: "assistant", content: "It is a pixel." },
  ]);
  assertEqual(regenerated.userText, "describe this", "regen user text");
  assertEqual(regenerated.images.length, 1, "regen must keep image attachment");
  assertEqual(regenerated.images[0]!.mimeType, "image/png", "regen image mime");

  const images = extractImagesFromContent([
    { type: "image_url", image_url: { url: png } },
  ]);
  assertEqual(images.length, 1, "image_url object form");

  assert(
    isTitleGenerationRequest([
      { role: "system", content: "You are a title generator" },
      { role: "user", content: "hello" },
    ]),
    "title detection",
  );
  assert(
    isSummaryGenerationRequest([
      {
        role: "system",
        content: "You are tasked with summarizing conversations",
      },
    ]),
    "summary detection",
  );

  assert(
    !hasUserSteerAfterTools([
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "t1",
            type: "function",
            function: { name: "shell", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "t1", content: "ok" },
      { role: "user", content: "next step" },
    ]),
    "completed tool round is not a steer",
  );

  assert(
    hasUserSteerAfterTools([
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "t1",
            type: "function",
            function: { name: "shell", arguments: "{}" },
          },
        ],
      },
      { role: "user", content: "stop and do this instead" },
    ]),
    "unresolved tool batch + trailing user is a steer",
  );

  assertEqual(
    buildInterruptSteerUserText("go").startsWith("Please follow this new instruction:"),
    true,
    "steer prefix",
  );

  const long = "x".repeat(30_000);
  const truncated = truncateToolResultForCursor(long);
  assert(truncated.length < long.length, "tool result truncation");
  assert(truncated.includes("truncated"), "truncation marker");

  const continuation = buildPostToolBridgeLossContinuation([
    { content: "build ok" },
  ]);
  assert(
    continuation.startsWith("Continue from the current conversation checkpoint."),
    "bridge-loss continuation cue",
  );
  assert(continuation.includes("build ok"), "bridge-loss includes tool output");

  const cost = estimateModelCost("claude-4.6-opus-high");
  assert(cost.input > 0 && cost.output > 0, "pricing lookup");

  await withTimeout(Promise.resolve(1), 1000);

  assert(
    isCursorOAuthCredential({
      type: "oauth",
      refresh: "r",
      expires: Date.now() + 1000,
    }),
    "oauth credential guard",
  );
  assert(!isCursorOAuthCredential({ type: "api" }), "rejects non-oauth");

  assertArrayEqual(["a"], ["a"], "assertArrayEqual sanity");

  console.log("[test] Extracted pure helpers OK");
}
