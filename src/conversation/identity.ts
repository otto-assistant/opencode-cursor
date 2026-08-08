import { createHash } from "node:crypto";
import type { CursorModelSelection } from "../model-selection.js";
import {
  extractAnchoredSummary,
  isPostCompactHistory,
  requestKeyNamespace,
} from "../openai/request-classifier.js";
import type { ChatCompletionRequest } from "../openai/types.js";
import { textContent } from "../openai/types.js";

export function buildConversationIdentity(body: ChatCompletionRequest): string {
  const rawIds = [
    body.conversation_id,
    body.thread_id,
    body.session_id,
    body.user,
  ];
  for (const id of rawIds) {
    if (typeof id === "string" && id.trim().length > 0) {
      return `id:${id.trim()}`;
    }
  }

  const metadata =
    body.metadata && typeof body.metadata === "object"
      ? body.metadata
      : undefined;
  if (metadata) {
    const candidateKeys = [
      "conversation_id",
      "thread_id",
      "session_id",
      "chat_id",
      "id",
    ];
    for (const key of candidateKeys) {
      const value = metadata[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return `meta:${key}:${value.trim()}`;
      }
    }
  }

  return "";
}

export function selectionIdentity(selection: CursorModelSelection): string {
  return JSON.stringify({
    modelId: selection.modelId,
    maxMode: selection.maxMode,
    parameters: selection.parameters,
  });
}

export function deriveBridgeKey(
  modelId: string,
  body: ChatCompletionRequest,
): string {
  const identity = buildConversationIdentity(body);
  const firstUserMsg = body.messages.find((m) => m.role === "user");
  const firstUserText = firstUserMsg ? textContent(firstUserMsg.content) : "";
  const ns = requestKeyNamespace(body.messages);
  let base = identity ? `${ns}${identity}` : `fallback:${ns}${firstUserText}`;
  if (!identity && isPostCompactHistory(body.messages)) {
    const summary = extractAnchoredSummary(body.messages);
    const fingerprint = createHash("sha256")
      .update(summary || `user:${firstUserText}`)
      .digest("hex")
      .slice(0, 16);
    base = `${ns}postcompact:${fingerprint}:fallback:${firstUserText}`;
  }
  return createHash("sha256")
    .update(`bridge:${modelId}:${base}`)
    .digest("hex")
    .slice(0, 24);
}

/**
 * Derive a key for conversation state. Model-independent so context survives
 * model switches.
 */
export function deriveConversationKey(body: ChatCompletionRequest): string {
  const identity = buildConversationIdentity(body);
  const firstUserMsg = body.messages.find((m) => m.role === "user");
  const firstUserText = firstUserMsg ? textContent(firstUserMsg.content) : "";
  const ns = requestKeyNamespace(body.messages);
  let fallbackSeed = `${ns}user:${firstUserText}`;
  if (!identity && isPostCompactHistory(body.messages)) {
    const summary = extractAnchoredSummary(body.messages);
    const fingerprint = createHash("sha256")
      .update(summary || `user:${firstUserText}`)
      .digest("hex")
      .slice(0, 16);
    fallbackSeed = `${ns}postcompact:${fingerprint}:user:${firstUserText}`;
  }
  const seed = identity ? `${ns}${identity}` : `fallback:${fallbackSeed}`;
  return createHash("sha256")
    .update(`conv:${seed}`)
    .digest("hex")
    .slice(0, 24);
}

/** Deterministic UUID derived from convKey so Cursor's conversation persists. */
export function deterministicConversationId(convKey: string): string {
  const hex = createHash("sha256")
    .update(`cursor-conv-id:${convKey}`)
    .digest("hex")
    .slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${(0x8 | (parseInt(hex[16], 16) & 0x3)).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}
