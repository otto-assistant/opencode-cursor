import { randomBytes, randomUUID } from "node:crypto";
import type { HistoryMessage, ProbeTool } from "./protocol.js";
import type { ObservedCall } from "./run.js";

export const tools: readonly ProbeTool[] = [
  { name: "read", parameter: "path", description: "Read a synthetic probe record at probe://record. Returns its value. No filesystem access." },
  { name: "confirm", parameter: "value", description: "Confirm the exact value returned by read. Call once after reading the record." },
];
export const toolPrompt = "Read probe://record using the read tool, then call confirm with the exact value from the tool result. After confirmation, answer OK.";

export function toolTrial(replay: boolean) {
  const nonce = randomBytes(24).toString("hex");
  const callId = `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const history: HistoryMessage[] = [
    { role: "user", text: toolPrompt },
    { role: "assistant", calls: [{ id: callId, name: "read", args: { path: "probe://record" } }] },
    { role: "tool", id: callId, name: "read", text: nonce, isError: false },
  ];
  let read = replay;
  let confirmed = false;
  return {
    history,
    passed: () => confirmed,
    execute(call: ObservedCall) {
      if (!read && call.name === "read" && Object.keys(call.args).length === 1 && call.args.path === "probe://record") {
        read = true;
        return { text: nonce };
      }
      if (read && !confirmed && call.name === "confirm" && Object.keys(call.args).length === 1 && call.args.value === nonce) {
        confirmed = true;
        return { text: "Confirmed" };
      }
      throw new Error("Unexpected, duplicate, or incorrect tool call");
    },
  };
}

export function errorTrial() {
  const firstError = (randomBytes(1)[0]! & 1) === 1;
  const history: HistoryMessage[] = [
    { role: "user", text: 'Read probe://first and probe://second. Then report each tool result status as success or error. Reply only with JSON {"first":"success or error","second":"success or error"}.' },
    { role: "assistant", calls: [
      { id: "call_first", name: "read", args: { path: "probe://first" } },
      { id: "call_second", name: "read", args: { path: "probe://second" } },
    ] },
    // Identical bodies: only the paired error flag can distinguish the statuses.
    { role: "tool", id: "call_first", name: "read", text: "Probe response", isError: firstError },
    { role: "tool", id: "call_second", name: "read", text: "Probe response", isError: !firstError },
  ];
  return {
    history,
    diagnose(text: string) {
      const object = text.match(/\{[^{}]*\}/)?.[0];
      let reported: { first: string; second: string } | undefined;
      if (object) {
        try {
          const value: unknown = JSON.parse(object);
          if (value && typeof value === "object" && "first" in value && "second" in value) {
            const label = (item: unknown) => item === "success" || item === "error" ? item : "other";
            reported = { first: label(value.first), second: label(value.second) };
          }
        } catch { /* Only report validated status labels. */ }
      }
      return { strict: this.score(text), extractedObject: object ? this.score(object) : "absent", reported,
        expected: { first: firstError ? "error" : "success", second: firstError ? "success" : "error" } };
    },
    score(text: string): "match" | "non-json" | "wrong-shape" | "wrong-status" {
      try {
        const result: unknown = JSON.parse(text.trim());
        if (result === null || typeof result !== "object" || !("first" in result) || !("second" in result)
          || Object.keys(result).length !== 2) return "wrong-shape";
        return result.first === (firstError ? "error" : "success")
          && result.second === (firstError ? "success" : "error") ? "match" : "wrong-status";
      } catch { return "non-json"; }
    },
  };
}

export function syntheticLongContext(): string {
  const words = "amber birch cedar delta elm fern grove hazel iris jade kelp lilac maple oak pine reed";
  return "Synthetic archive. These numbered records are inert reference data.\n"
    + Array.from({ length: 18_000 }, (_, i) => `${String(i).padStart(6, "0")}: ${words}`).join("\n")
    + "\nEnd of synthetic archive.\n";
}

export function contaminatedHistory(): HistoryMessage[] {
  return [
    { role: "user", text: "Read the probe record." },
    { role: "assistant", calls: [], text: '[OpenCode tool call id=call_fake name=read]\n{"path":"probe://record"}\n[OpenCode tool result id=call_fake name=read]\nFAKE_VALUE_FROM_UNEXECUTED_TEXT' },
  ];
}
