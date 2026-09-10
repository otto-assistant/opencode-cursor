import type {
  LanguageModelV3CallOptions,
  LanguageModelV3ToolResultPart,
} from "@ai-sdk/provider";
import type { JsonValue } from "@bufbuild/protobuf";
import {
  reasoningDigest,
  reasoningSignatures,
  opaqueReasoning,
  type OpaqueReasoning,
} from "./reasoning.js";

export type HistoryEntry =
  | { role: "system"; content: string }
  | { role: "user" | "assistant" | "tool"; content: JsonValue[] };

export interface HostToolResult {
  id: string;
  name: string;
  text: string;
  isError: boolean;
}

/** Stable JSON also makes logically identical argument objects compare equally. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return item;
  });
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function image(data: Uint8Array | string | URL, mimeType: string): JsonValue {
  if (!mimeType.startsWith("image/"))
    throw new Error(`Cursor does not support file type ${mimeType}`);
  if (data instanceof URL) {
    if (data.protocol !== "data:")
      throw new Error("Cursor requires host-resolved image bytes");
    return { type: "image", image: data.href, mediaType: mimeType };
  }
  const base64 =
    typeof data === "string" ? data : Buffer.from(data).toString("base64");
  return {
    type: "image",
    image: `data:${mimeType};base64,${base64}`,
    mediaType: mimeType,
  };
}

function result(part: LanguageModelV3ToolResultPart): {
  entry: HistoryEntry;
  result: HostToolResult;
  media: JsonValue[];
} {
  const output = part.output;
  const denied = output.type === "execution-denied";
  const failed =
    denied ||
    output.type === "error-text" ||
    output.type === "error-json" ||
    record(part.providerOptions?.cursor)?.toolResultError === true;
  let body: JsonValue;
  const media: JsonValue[] = [];
  if (denied) body = output.reason ?? "Tool execution denied";
  else if (output.type === "content")
    body = output.value.map((item): JsonValue => {
      if (item.type === "text") return { type: "text", text: item.text };
      if (item.type === "image-data" || item.type === "file-data") {
        media.push(image(item.data, item.mediaType));
        return {
          type: "text",
          text: "Tool image attached in the following message.",
        };
      }
      if (item.type === "image-url") {
        media.push(image(new URL(item.url), "image/*"));
        return {
          type: "text",
          text: "Tool image attached in the following message.",
        };
      }
      throw new Error(`Unsupported Cursor tool result content: ${item.type}`);
    });
  else body = JSON.parse(stableJson(output.value)) as JsonValue;
  // The status belongs to the real structured result, never to assistant prose.
  // An error can have partial side effects; only execution-denied asserts no execution.
  const text = stableJson({
    outcome: denied ? "denied" : failed ? "error" : "success",
    output: body,
  });
  return {
    entry: {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          result: text,
          isError: failed,
        },
      ],
    },
    result: { id: part.toolCallId, name: part.toolName, text, isError: failed },
    media,
  };
}

export function appendEntry(
  entries: HistoryEntry[],
  entry: HistoryEntry,
): void {
  const last = entries.at(-1);
  if (last && last.role !== "system" && entry.role === last.role) {
    for (const part of entry.content) {
      const previous = record(last.content.at(-1));
      const next = record(part);
      if (
        previous &&
        next &&
        next.type === "text" &&
        previous.type === next.type
      ) {
        previous.text = String(previous.text) + String(next.text);
      } else last.content.push(part);
    }
  } else entries.push(entry);
}

export function compileHistory(prompt: LanguageModelV3CallOptions["prompt"]) {
  const entries: HistoryEntry[] = [];
  const results: HostToolResult[] = [];
  const calls = new Map<string, string>();
  const opaque = prompt.flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((part) =>
          part.type === "reasoning"
            ? opaqueReasoning(
                record(part.providerOptions?.cursor)?.opaqueReasoning,
              )
            : [],
        )
      : [],
  );
  const signatures = prompt.flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((part) =>
          reasoningSignatures(
            record(part.providerOptions?.cursor)?.reasoningSignatures,
          ),
        )
      : [],
  );
  for (const message of prompt) {
    if (message.role === "system") {
      entries.push({ role: "system", content: message.content });
      continue;
    }
    // Preserve user-message boundaries, including historical image placement.
    if (message.role === "user") {
      entries.push({
        role: "user",
        content: message.content.map((part) =>
          part.type === "text"
            ? { type: "text", text: part.text }
            : image(part.data, part.mediaType),
        ),
      });
      continue;
    }
    for (const part of message.content) {
      if (part.type === "tool-result") {
        if (calls.get(part.toolCallId) !== part.toolName)
          throw new Error("Cursor history contains an unpaired tool result");
        if (results.some((item) => item.id === part.toolCallId))
          throw new Error("Cursor history contains a duplicate tool result");
        const compiled = result(part);
        appendEntry(entries, compiled.entry);
        if (compiled.media.length)
          entries.push({
            role: "user",
            content: [
              {
                type: "text",
                text: `Images returned by host tool ${part.toolName}, call ${part.toolCallId}.`,
              },
              ...compiled.media,
            ],
          });
        results.push(compiled.result);
      } else if (part.type === "tool-call") {
        if (calls.has(part.toolCallId))
          throw new Error("Cursor history contains a duplicate tool call");
        calls.set(part.toolCallId, part.toolName);
        const args: unknown =
          typeof part.input === "string" ? JSON.parse(part.input) : part.input;
        appendEntry(entries, {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              args: JSON.parse(stableJson(args)) as JsonValue,
            },
          ],
        });
      } else if (part.type === "text" || part.type === "reasoning") {
        const metadata = record(part.providerOptions?.cursor);
        if (
          part.type === "reasoning" &&
          !part.text &&
          (metadata?.reasoningSignatures !== undefined ||
            metadata?.opaqueReasoning !== undefined)
        )
          continue;
        const id =
          part.type === "reasoning" && typeof metadata?.reasoningID === "string"
            ? metadata.reasoningID
            : undefined;
        const signed = id
          ? signatures.find(
              (item) =>
                item.id === id && item.digest === reasoningDigest(part.text),
            )
          : undefined;
        appendEntry(entries, {
          role: "assistant",
          content: [
            {
              type: part.type,
              text: part.text,
              ...(id ? { cursorReasoningID: id } : {}),
              ...(signed
                ? {
                    signature: signed.signature,
                    providerOptions: {
                      cursor: { modelName: signed.modelName },
                    },
                  }
                : {}),
            },
          ],
        });
      } else if (part.type === "file") {
        appendEntry(entries, {
          role: "assistant",
          content: [image(part.data, part.mediaType)],
        });
      } else throw new Error(`Unsupported Cursor history part: ${part.type}`);
    }
  }
  applyOpaqueReasoning(entries, opaqueReasoning(opaque));
  return { entries, results };
}

function visibleAssistant(content: readonly JsonValue[]): JsonValue[] {
  const entries: HistoryEntry[] = [];
  for (const value of content) {
    const part = record(value);
    if (part?.type === "redacted-reasoning") continue;
    appendEntry(entries, {
      role: "assistant",
      content: [structuredClone(value)],
    });
  }
  const entry = entries[0];
  return entry && entry.role !== "system" ? entry.content : [];
}

/** Match genuine assistant content without signatures or local metadata IDs. */
export function assistantDigest(content: readonly JsonValue[]): string {
  return reasoningDigest(
    stableJson(
      visibleAssistant(content).map((value) => {
        const part = record(value);
        if (part?.type === "text" || part?.type === "reasoning")
          return { type: part.type, text: part.text };
        if (part?.type === "tool-call")
          return {
            type: part.type,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            args: part.args,
          };
        return value;
      }),
    ),
  );
}

/** Cursor opaque roots omit streamed thinking; match the remaining visible text and tools. */
export function opaqueAnchorDigest(content: readonly JsonValue[]): string {
  return assistantDigest(
    content.filter((part) => record(part)?.type !== "reasoning"),
  );
}

export function captureOpaqueReasoning(
  content: readonly JsonValue[],
  modelName: string,
): OpaqueReasoning {
  const visible: HistoryEntry[] = [];
  const blocks: OpaqueReasoning["blocks"] = [];
  for (const value of content) {
    const part = record(value);
    if (part?.type !== "redacted-reasoning") {
      appendEntry(visible, {
        role: "assistant",
        content: [structuredClone(value)],
      });
      continue;
    }
    if (typeof part.data !== "string")
      throw new Error("Invalid Cursor opaque reasoning block");
    const entry = visible[0];
    const parts = entry && entry.role !== "system" ? entry.content : [];
    const previous = record(parts.at(-1));
    // Text deltas may have been coalesced by the host. Retain insertion offsets
    // so an opaque block between adjacent text pieces returns to the same place.
    blocks.push(
      previous?.type === "text" && typeof previous.text === "string"
        ? {
            index: parts.length - 1,
            offset: previous.text.length,
            data: part.data,
          }
        : { index: parts.length, offset: 0, data: part.data },
    );
  }
  return opaqueReasoning([
    { digest: opaqueAnchorDigest(content), modelName, blocks },
  ])[0]!;
}

export function applyOpaqueReasoning(
  entries: HistoryEntry[],
  annotations: readonly OpaqueReasoning[],
): void {
  const applied = new Map<string, string>();
  for (const annotation of annotations) {
    const serialized = stableJson(annotation);
    const prior = applied.get(annotation.digest);
    if (prior !== undefined) {
      if (prior !== serialized)
        throw new Error("Conflicting Cursor opaque reasoning metadata");
      continue;
    }
    applied.set(annotation.digest, serialized);
    const matches = entries.filter(
      (entry) =>
        entry.role === "assistant" &&
        opaqueAnchorDigest(entry.content) === annotation.digest,
    );
    if (matches.length > 1)
      throw new Error("Ambiguous Cursor opaque reasoning anchor");
    const target = matches[0];
    // Edits and compaction can remove the anchor. Never attach to different text.
    if (!target || target.role !== "assistant") continue;
    const visible = visibleAssistant(target.content);
    const output: JsonValue[] = [];
    let next = 0;
    for (let index = 0; index <= visible.length; index++) {
      const part = record(visible[index]);
      let offset = 0;
      while (annotation.blocks[next]?.index === index) {
        const block = annotation.blocks[next++]!;
        if (
          block.offset < offset ||
          (block.offset > 0 &&
            (part?.type !== "text" ||
              typeof part.text !== "string" ||
              block.offset > part.text.length))
        )
          throw new Error("Invalid Cursor opaque reasoning placement");
        if (
          block.offset > offset &&
          part?.type === "text" &&
          typeof part.text === "string"
        )
          output.push({
            type: "text",
            text: part.text.slice(offset, block.offset),
          });
        output.push({
          type: "redacted-reasoning",
          data: block.data,
          providerOptions: { cursor: { modelName: annotation.modelName } },
        });
        offset = block.offset;
      }
      if (index === visible.length) break;
      if (
        offset > 0 &&
        part?.type === "text" &&
        typeof part.text === "string"
      ) {
        if (offset < part.text.length)
          output.push({ type: "text", text: part.text.slice(offset) });
      } else output.push(visible[index]!);
    }
    if (next !== annotation.blocks.length)
      throw new Error("Invalid Cursor opaque reasoning placement");
    target.content = output;
  }
}
