import { describe, expect, test } from "bun:test";
import {
  deriveConversationKey,
  isTitleGenerationRequest,
  resolveConversationIdentity,
} from "../../src/proxy";

type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ function?: { name?: string } }>;
};

function makeBody(overrides: Partial<any> = {}): any {
  return {
    model: "gpt-5.2",
    messages: [{ role: "user", content: "hello" } satisfies Message],
    ...overrides,
  };
}

describe("resolveConversationIdentity", () => {
  test("prefers conversation_id", () => {
    expect(resolveConversationIdentity(makeBody({
      conversation_id: "conv-1",
      thread_id: "thread-1",
      session_id: "session-1",
      user: "user-1",
    }))).toEqual({ identity: "id:conv-1", source: "conversation_id" });
  });

  test("falls back through thread_id then session_id", () => {
    expect(resolveConversationIdentity(makeBody({
      thread_id: "thread-1",
      session_id: "session-1",
    }))).toEqual({ identity: "id:thread-1", source: "thread_id" });

    expect(resolveConversationIdentity(makeBody({
      session_id: "session-1",
    }))).toEqual({ identity: "id:session-1", source: "session_id" });
  });

  test("uses metadata/user fallback when explicit ids are absent", () => {
    expect(resolveConversationIdentity(makeBody({
      metadata: { conversation_id: "meta-conv" },
    }))).toEqual({
      identity: "meta:conversation_id:meta-conv",
      source: "metadata:conversation_id",
    });
  });

  test("returns fallback identity when no id-like fields exist", () => {
    expect(resolveConversationIdentity(makeBody({
      metadata: { random: "value" },
      user: "plain-user",
    }))).toEqual({ identity: "", source: "fallback" });
  });
});

describe("deriveConversationKey", () => {
  test("is stable when explicit identity is present", () => {
    const a = deriveConversationKey(makeBody({
      conversation_id: "conv-42",
      messages: [{ role: "user", content: "first text" }],
    }));
    const b = deriveConversationKey(makeBody({
      conversation_id: "conv-42",
      messages: [{ role: "user", content: "different text" }],
    }));
    expect(a).toBe(b);
    expect(a.length).toBe(24);
  });

  test("uses fallback path when identity is absent", () => {
    const base = makeBody({
      messages: [
        { role: "system", content: "you are assistant" },
        { role: "user", content: "question one" },
      ],
      tools: [{ function: { name: "search" } }],
      user: "u-1",
    });
    const same = makeBody({
      messages: [
        { role: "system", content: "different system message" },
        { role: "user", content: "question one" },
      ],
      tools: [{ function: { name: "search" } }],
      user: "u-1",
    });
    const changed = makeBody({
      messages: [{ role: "user", content: "question two" }],
      tools: [{ function: { name: "search" } }],
      user: "u-1",
    });
    expect(deriveConversationKey(base)).toBe(deriveConversationKey(same));
    expect(deriveConversationKey(base)).not.toBe(deriveConversationKey(changed));
  });
});

describe("isTitleGenerationRequest", () => {
  test("detects title-generator style system prompts", () => {
    expect(isTitleGenerationRequest([
      { role: "system", content: "You are a title generator for chats." },
      { role: "user", content: "Summarize this" },
    ])).toBe(true);

    expect(isTitleGenerationRequest([
      { role: "system", content: "Please generate a short title only." },
      { role: "user", content: "Explain mutexes" },
    ])).toBe(true);
  });

  test("returns false for regular requests", () => {
    expect(isTitleGenerationRequest([
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Normal question" },
    ])).toBe(false);
  });
});
