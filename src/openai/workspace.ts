/** Extract the real workspace root from OpenCode's system prompt. */
export function extractWorkspaceRoot(systemPrompt: string): string | undefined {
  const wdMatch = systemPrompt.match(/Working directory:\s*(\S+)/i);
  if (wdMatch?.[1]) return wdMatch[1];
  const wsMatch = systemPrompt.match(/Workspace root folder:\s*(\S+)/i);
  if (wsMatch?.[1]) return wsMatch[1];
  return undefined;
}
