import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { decodeCursorModelSelection, encodeCursorModelSelection, type CursorModelSelection } from "../src/model-selection.js";
import { contaminatedHistory, errorTrial, syntheticLongContext, tools, toolPrompt, toolTrial } from "./cursor-capability/cases.js";
import { runProbe, type Observation } from "./cursor-capability/run.js";

async function main() {
  const { values } = parseArgs({ options: {
    help: { type: "boolean", short: "h" }, live: { type: "boolean" },
    "follow-up": { type: "boolean" },
    selections: { type: "string" }, "timeout-ms": { type: "string", default: "180000" },
  } });
  if (values.help) {
    console.log("Usage: node probe.mjs --live --selections models.json [--timeout-ms 180000]\n"
      + "Requires CURSOR_ACCESS_TOKEN in the environment. Reads no auth store.\n"
      + "models.json: 1–3 exact discovered CursorModelSelection objects. Six synthetic Runs/model.\n"
      + "--follow-up: 12 targeted Runs, including synthetic long context; requires Auto, Composer 2.5 and Opus 4.6 1M Thinking/max.\n"
      + "Outputs NDJSON scores, tool names, timings and token counts; no transcripts or credentials.");
    return;
  }
  if (!values.live || !values.selections) throw new Error("Use --live --selections models.json (see --help)");
  const timeoutMs = Number(values["timeout-ms"]);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000) throw new Error("timeout-ms must be 1–180000");
  const raw: unknown = JSON.parse(await readFile(values.selections, "utf8"));
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3) throw new Error("Expected 1–3 discovered model selections");
  const selections: CursorModelSelection[] = raw.map((item: unknown) => {
    const selection = decodeCursorModelSelection(Buffer.from(JSON.stringify(item)).toString("base64url"));
    if (!selection) throw new Error("Invalid model selection");
    return selection;
  });
  if (new Set(selections.map(encodeCursorModelSelection)).size !== selections.length) throw new Error("Duplicate selections");
  const exactOpus = selections.find((item) => item.modelId === "claude-opus-4-6" && item.maxMode
    && ["thinking:true", "context:1m", "effort:max"].every((expected) => item.parameters.some((p) => `${p.id}:${p.value}` === expected)));
  const composer = selections.find((item) => item.modelId === "composer-2.5");
  if (values["follow-up"] && (!exactOpus || !composer || !selections.some((item) => item.modelId === "default"))) {
    throw new Error("Follow-up requires Auto, Composer 2.5 and Opus 4.6 1M Thinking/max");
  }
  const runBudget = values["follow-up"] ? 12 : selections.length * 6;
  const accessToken = process.env.CURSOR_ACCESS_TOKEN;
  if (!accessToken) throw new Error("CURSOR_ACCESS_TOKEN is required");
  delete process.env.CURSOR_ACCESS_TOKEN;
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let calls = 0;
  let passed = 0;
  const record = (selection: CursorModelSelection, name: string, result: Observation, outcome: boolean,
    score?: string | ReturnType<ReturnType<typeof errorTrial>["diagnose"]>) => {
    const pass = outcome && result.turnEnded && !result.failure;
    if (pass) passed++;
    console.log(JSON.stringify({ type: "result", model: selection.publicId, case: name,
      pass, failure: result.failure, turnEnded: result.turnEnded,
      score, textToolMarkers: [...result.text.matchAll(/\[OpenCode tool (?:call|result)[^\]\n]*\]/g)].length,
      toolNames: result.calls.map((call) => call.name), execs: result.execs,
      blobReads: result.blobReads, elapsedMs: result.elapsedMs,
      inputTokens: result.inputTokens, outputTokens: result.outputTokens,
    }));
  };
  console.log(JSON.stringify({ type: "probe", version: 3, suite: values["follow-up"] ? "follow-up" : "matrix", startedAt: new Date().toISOString(),
    runBudget, timeoutMs, selections,
    endpoint: "https://api2.cursor.sh", clientVersion: "cli-2026.01.09-231024f",
  }));
  const run = async (selection: CursorModelSelection, name: string,
    input: Omit<Parameters<typeof runProbe>[0], "accessToken" | "selection">) => {
    if (abort.signal.aborted) throw new Error("Probe interrupted");
    if (++calls > runBudget) throw new Error("Run budget exceeded");
    console.log(JSON.stringify({ type: "start", model: selection.publicId, case: name, run: calls }));
    return runProbe({ ...input, accessToken, selection, timeoutMs, signal: abort.signal });
  };
  try {
    if (values["follow-up"] && exactOpus && composer) {
      for (const selection of selections) {
        const errors = errorTrial();
        for (const rootToolMessageId of [false, true]) {
          const name = rootToolMessageId ? "roots-errors-with-id" : "roots-errors-no-id";
          const result = await run(selection, name, { tools: [], prompt: "Continue.", format: "roots",
            history: errors.history, rootToolMessageId });
          record(selection, name, result, errors.score(result.text) === "match", errors.diagnose(result.text));
        }
      }
      const live = toolTrial(false);
      const result = await run(exactOpus, "exact-opus-live-tools", { tools, prompt: toolPrompt, execute: live.execute });
      record(exactOpus, "exact-opus-live-tools", result, live.passed() && result.calls.length === 2);
      for (const scenario of ["clean", "long", "contaminated"] as const) {
        const trial = toolTrial(true);
        const history = scenario === "long"
          ? [{ role: "user" as const, text: syntheticLongContext() }, ...trial.history]
          : scenario === "contaminated" ? [...contaminatedHistory(), ...trial.history] : trial.history;
        const name = `exact-opus-roots-${scenario}`;
        const result = await run(exactOpus, name, { tools, prompt: "Continue.", format: "roots",
          history, rootToolMessageId: true, execute: trial.execute });
        const sufficientContext = scenario !== "long" || result.inputTokens >= 300_000;
        record(exactOpus, name, result, trial.passed() && result.calls.length === 1 && sufficientContext,
          sufficientContext ? undefined : "insufficient-reported-context");
      }
      for (const selection of [composer, exactOpus]) {
        const errors = errorTrial();
        const history = errors.history.map((message) => message.role === "tool"
          ? { ...message, text: message.isError ? "Read failed: synthetic permission denied." : "Read succeeded: synthetic record available." }
          : message);
        const result = await run(selection, "roots-errors-explicit-body", { tools: [], prompt: "Continue.", format: "roots",
          history, rootToolMessageId: true });
        record(selection, "roots-errors-explicit-body", result, errors.score(result.text) === "match", errors.diagnose(result.text));
      }
    } else {
      for (const selection of selections) {
        const empty = await run(selection, "empty-toolset", { tools: [],
          prompt: "Use a shell tool to obtain the current working directory. If no execution tool is offered, respond exactly NO_TOOLS.",
        });
        record(selection, "empty-toolset", empty, empty.calls.length === 0 && empty.text.trim() === "NO_TOOLS");
        const live = toolTrial(false);
        const loop = await run(selection, "live-tool-loop", { tools, prompt: toolPrompt, execute: live.execute });
        record(selection, "live-tool-loop", loop, live.passed() && loop.calls.length === 2);
        // Each request gets a fresh conversation ID and H2 session.
        const errors = errorTrial();
        for (const format of ["roots", "inline"] as const) {
          const trial = toolTrial(true);
          // Each format gets its own nonce to prevent cross-run recall from masking replay failure.
          const result = await run(selection, `${format}-tool-replay`, { tools, prompt: "Continue.", format,
            history: trial.history, execute: trial.execute,
          });
          record(selection, `${format}-tool-replay`, result, trial.passed() && result.calls.length === 1);
          const status = await run(selection, `${format}-error-replay`, { tools: [], prompt: "Continue.", format, history: errors.history });
          const score = errors.score(status.text);
          record(selection, `${format}-error-replay`, status, score === "match", score);
        }
      }
    }
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    console.log(JSON.stringify({ type: "summary", runs: calls, passed, expected: runBudget }));
  }
  if (passed !== runBudget) process.exitCode = 1;
}

main().catch(() => {
  // Never print exception payloads: credentials and remote content are not diagnostic output.
  console.error("Probe could not complete. Check arguments, selection file, token and interruption (see --help).");
  process.exitCode = 1;
});
