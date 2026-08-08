/** $/M token rates from cursor.com/docs/models-and-pricing */

export interface ModelCost {
  input: number;
  output: number;
  cache: { read: number; write: number };
}

const MODEL_COST_TABLE: Record<string, ModelCost> = {
  // Anthropic
  "claude-4-sonnet": { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
  "claude-4-sonnet-1m": {
    input: 6,
    output: 22.5,
    cache: { read: 0.6, write: 7.5 },
  },
  "claude-4.5-haiku": {
    input: 1,
    output: 5,
    cache: { read: 0.1, write: 1.25 },
  },
  "claude-4.5-opus": {
    input: 5,
    output: 25,
    cache: { read: 0.5, write: 6.25 },
  },
  "claude-4.5-sonnet": {
    input: 3,
    output: 15,
    cache: { read: 0.3, write: 3.75 },
  },
  "claude-4.6-opus": {
    input: 5,
    output: 25,
    cache: { read: 0.5, write: 6.25 },
  },
  "claude-4.6-opus-fast": {
    input: 30,
    output: 150,
    cache: { read: 3, write: 37.5 },
  },
  "claude-4.6-sonnet": {
    input: 3,
    output: 15,
    cache: { read: 0.3, write: 3.75 },
  },

  // Cursor
  "composer-1": {
    input: 1.25,
    output: 10,
    cache: { read: 0.125, write: 0 },
  },
  "composer-1.5": {
    input: 3.5,
    output: 17.5,
    cache: { read: 0.35, write: 0 },
  },
  "composer-2": { input: 0.5, output: 2.5, cache: { read: 0.2, write: 0 } },
  "composer-2-fast": {
    input: 1.5,
    output: 7.5,
    cache: { read: 0.2, write: 0 },
  },

  // Google
  "gemini-2.5-flash": {
    input: 0.3,
    output: 2.5,
    cache: { read: 0.03, write: 0 },
  },
  "gemini-3-flash": { input: 0.5, output: 3, cache: { read: 0.05, write: 0 } },
  "gemini-3-pro": { input: 2, output: 12, cache: { read: 0.2, write: 0 } },
  "gemini-3-pro-image": {
    input: 2,
    output: 12,
    cache: { read: 0.2, write: 0 },
  },
  "gemini-3.1-pro": { input: 2, output: 12, cache: { read: 0.2, write: 0 } },

  // OpenAI
  "gpt-5": { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } },
  "gpt-5-fast": { input: 2.5, output: 20, cache: { read: 0.25, write: 0 } },
  "gpt-5-mini": { input: 0.25, output: 2, cache: { read: 0.025, write: 0 } },
  "gpt-5-codex": { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } },
  "gpt-5.1-codex": {
    input: 1.25,
    output: 10,
    cache: { read: 0.125, write: 0 },
  },
  "gpt-5.1-codex-max": {
    input: 1.25,
    output: 10,
    cache: { read: 0.125, write: 0 },
  },
  "gpt-5.1-codex-mini": {
    input: 0.25,
    output: 2,
    cache: { read: 0.025, write: 0 },
  },
  "gpt-5.2": { input: 1.75, output: 14, cache: { read: 0.175, write: 0 } },
  "gpt-5.2-codex": {
    input: 1.75,
    output: 14,
    cache: { read: 0.175, write: 0 },
  },
  "gpt-5.3-codex": {
    input: 1.75,
    output: 14,
    cache: { read: 0.175, write: 0 },
  },
  "gpt-5.4": { input: 2.5, output: 15, cache: { read: 0.25, write: 0 } },
  "gpt-5.4-mini": {
    input: 0.75,
    output: 4.5,
    cache: { read: 0.075, write: 0 },
  },
  "gpt-5.4-nano": {
    input: 0.2,
    output: 1.25,
    cache: { read: 0.02, write: 0 },
  },

  // xAI
  "grok-4-5": { input: 2, output: 6, cache: { read: 0.2, write: 0 } },
  "grok-4.20": { input: 2, output: 6, cache: { read: 0.2, write: 0 } },
  "grok-4-fast-reasoning": {
    input: 2,
    output: 6,
    cache: { read: 0.2, write: 0 },
  },
  "grok-4-0709": { input: 2, output: 6, cache: { read: 0.2, write: 0 } },

  // Moonshot
  "kimi-k2.5": { input: 0.6, output: 3, cache: { read: 0.1, write: 0 } },
};

// Most-specific first
const MODEL_COST_PATTERNS: Array<{
  match: (id: string) => boolean;
  cost: ModelCost;
}> = [
  {
    match: (id) => /claude.*opus.*fast/i.test(id),
    cost: MODEL_COST_TABLE["claude-4.6-opus-fast"]!,
  },
  {
    match: (id) => /claude.*opus/i.test(id),
    cost: MODEL_COST_TABLE["claude-4.6-opus"]!,
  },
  {
    match: (id) => /claude.*haiku/i.test(id),
    cost: MODEL_COST_TABLE["claude-4.5-haiku"]!,
  },
  {
    match: (id) => /claude.*sonnet/i.test(id),
    cost: MODEL_COST_TABLE["claude-4.6-sonnet"]!,
  },
  {
    match: (id) => /claude/i.test(id),
    cost: MODEL_COST_TABLE["claude-4.6-sonnet"]!,
  },
  {
    match: (id) => /composer-?2/i.test(id),
    cost: MODEL_COST_TABLE["composer-2"]!,
  },
  {
    match: (id) => /composer-?1\.5/i.test(id),
    cost: MODEL_COST_TABLE["composer-1.5"]!,
  },
  {
    match: (id) => /composer/i.test(id),
    cost: MODEL_COST_TABLE["composer-1"]!,
  },
  {
    match: (id) => /gpt-5\.4.*nano/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5.4-nano"]!,
  },
  {
    match: (id) => /gpt-5\.4.*mini/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5.4-mini"]!,
  },
  {
    match: (id) => /gpt-5\.4/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5.4"]!,
  },
  {
    match: (id) => /gpt-5\.3/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5.3-codex"]!,
  },
  {
    match: (id) => /gpt-5\.2/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5.2"]!,
  },
  {
    match: (id) => /gpt-5\.1.*mini/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5.1-codex-mini"]!,
  },
  {
    match: (id) => /gpt-5\.1/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5.1-codex"]!,
  },
  {
    match: (id) => /gpt-5.*mini/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5-mini"]!,
  },
  {
    match: (id) => /gpt-5.*fast/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5-fast"]!,
  },
  {
    match: (id) => /gpt-5/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5"]!,
  },
  {
    match: (id) => /gemini.*3\.1/i.test(id),
    cost: MODEL_COST_TABLE["gemini-3.1-pro"]!,
  },
  {
    match: (id) => /gemini.*3.*flash/i.test(id),
    cost: MODEL_COST_TABLE["gemini-3-flash"]!,
  },
  {
    match: (id) => /gemini.*3/i.test(id),
    cost: MODEL_COST_TABLE["gemini-3-pro"]!,
  },
  {
    match: (id) => /gemini.*flash/i.test(id),
    cost: MODEL_COST_TABLE["gemini-2.5-flash"]!,
  },
  {
    match: (id) => /gemini/i.test(id),
    cost: MODEL_COST_TABLE["gemini-3.1-pro"]!,
  },
  {
    match: (id) => /grok/i.test(id),
    cost: MODEL_COST_TABLE["grok-4.20"]!,
  },
  {
    match: (id) => /kimi/i.test(id),
    cost: MODEL_COST_TABLE["kimi-k2.5"]!,
  },
];

const DEFAULT_COST: ModelCost = {
  input: 3,
  output: 15,
  cache: { read: 0.3, write: 0 },
};

export function estimateModelCost(modelId: string): ModelCost {
  const normalized = modelId.toLowerCase();
  const exact = MODEL_COST_TABLE[normalized];
  if (exact) return exact;

  const stripped = normalized.replace(
    /-(high|medium|low|preview|thinking|spark-preview)$/g,
    "",
  );
  const strippedMatch = MODEL_COST_TABLE[stripped];
  if (strippedMatch) return strippedMatch;

  return MODEL_COST_PATTERNS.find((p) => p.match(normalized))?.cost ?? DEFAULT_COST;
}
