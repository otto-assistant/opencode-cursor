import { tool } from "@opencode-ai/plugin";

const s = tool.schema;

const ContentPartSchema = s.object({
  type: s.string(),
  text: s.string().optional(),
});

const OpenAIToolCallSchema = s.object({
  id: s.string(),
  type: s.literal("function"),
  function: s.object({
    name: s.string(),
    arguments: s.string(),
  }),
});

const OpenAIMessageSchema = s.object({
  role: s.enum(["system", "user", "assistant", "tool"]),
  content: s.union([s.string(), s.null(), s.array(ContentPartSchema)]),
  tool_call_id: s.string().optional(),
  tool_calls: s.array(OpenAIToolCallSchema).optional(),
});

const OpenAIToolDefSchema = s.object({
  type: s.literal("function"),
  function: s.object({
    name: s.string(),
    description: s.string().optional(),
    parameters: s.record(s.string(), s.unknown()).optional(),
  }),
});

// Re-export as `any` to avoid zod type portability issues across package boundaries.
// The runtime schema is fully validated; TypeScript consumers use ChatCompletionRequest interface.
export const ChatCompletionRequestSchema: any = s.object({
  model: s.string(),
  messages: s.array(OpenAIMessageSchema),
  stream: s.boolean().optional(),
  temperature: s.number().optional(),
  max_tokens: s.number().optional(),
  tools: s.array(OpenAIToolDefSchema).optional(),
  tool_choice: s.unknown().optional(),
  user: s.string().optional(),
  metadata: s.record(s.string(), s.unknown()).optional(),
  thread_id: s.string().optional(),
  conversation_id: s.string().optional(),
  session_id: s.string().optional(),
});
