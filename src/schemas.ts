import { tool } from "@opencode-ai/plugin";

const z = tool.schema;

const ContentPartSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
});

const OpenAIToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

const OpenAIMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.null(), z.array(ContentPartSchema)]),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(OpenAIToolCallSchema).optional(),
});

const OpenAIToolDefSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
  }),
});

export const ChatCompletionRequestSchema = z.object({
  model: z.string(),
  messages: z.array(OpenAIMessageSchema),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
  tools: z.array(OpenAIToolDefSchema).optional(),
  tool_choice: z.unknown().optional(),
  user: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  thread_id: z.string().optional(),
  conversation_id: z.string().optional(),
  session_id: z.string().optional(),
});
