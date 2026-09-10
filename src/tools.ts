/** Host function-tool snapshot advertised through Cursor MCP. */
export interface CursorToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}
