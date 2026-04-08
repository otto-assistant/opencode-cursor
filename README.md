# @otto-assistant/opencode-cursor-oauth

[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](#license)

High-quality OpenCode provider plugin that brings Cursor models into OpenCode through OAuth, model discovery, and a local OpenAI-compatible proxy.

Designed for real-world agent usage: streaming, tool calls, long conversations, and robust continuation behavior.

## Highlights

- OAuth login with automatic token refresh
- Cursor model discovery directly from API
- OpenAI-compatible `/v1/chat/completions` proxy for OpenCode runtime compatibility
- Stable streaming with tool-calling continuation
- MCP-first tool execution flow for practical agent environments
- Conversation-state handling built for long and tool-heavy sessions
- Production-ready smoke test coverage

## Why teams use it

- **Native feel in OpenCode:** Cursor models are exposed as a regular provider flow in OpenCode.
- **Reliable tool loops:** Tool call handoff and continuation are engineered for iterative agent workflows.
- **Operationally practical:** Focused on reducing common runtime failure modes around streaming, tool calls, and conversation state.
- **Simple integration surface:** Works with standard OpenCode plugin configuration and auth flow.

## Installation

### Option A: Install from npm (recommended)

```sh
npm install -g @otto-assistant/opencode-cursor-oauth
```

Then add this to `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@otto-assistant/opencode-cursor-oauth"
  ],
  "provider": {
    "cursor": {
      "name": "Cursor"
    }
  }
}
```

### Option B: Install from repository source

```sh
git clone https://github.com/otto-assistant/opencode-cursor.git
cd opencode-cursor
bun install
bun run build
npm install -g .
```

Use the same OpenCode config shown above.

## Authentication

```sh
opencode auth login --provider cursor
```

This opens Cursor OAuth in your browser. Tokens are stored in `~/.local/share/opencode/auth.json` and refreshed automatically.

## Quick usage

1. Start OpenCode.
2. Select provider `cursor`.
3. Choose a Cursor model.
4. Send prompts as usual; the plugin starts the local proxy on demand.

## Architecture

```text
OpenCode
  -> /v1/chat/completions
  -> Bun.serve proxy
  -> Node HTTP/2 bridge (h2-bridge.mjs)
  -> Cursor gRPC API (api2.cursor.sh)
```

### Tool-call lifecycle

```text
1) Model receives tool definitions via request context
2) Model emits tool call
3) Proxy maps tool call into OpenCode-compatible stream events
4) OpenCode executes tool
5) Tool result is sent back
6) Proxy resumes Cursor stream continuation
```

## Development

```sh
bun install
bun run build
bun run test
```

## Compatibility

- OpenCode plugin runtime
- Bun runtime
- Node.js >= 18 (HTTP/2 bridge process)
- Active Cursor subscription

## Performance and reliability notes

- Conversation state is managed to support continuation across multi-turn tool usage.
- Streaming and bridge lifecycle handling are designed to minimize stuck sessions.
- Tool execution path is optimized for MCP-based environments.

## FAQ

### Do I need to clone the repository to use this plugin?
Usually no. OpenCode can install npm plugins automatically when configured.

### Is this package published on npm?
This repository publishes under `@otto-assistant/opencode-cursor-oauth`. If npm install fails, verify that the latest GitHub release workflow completed successfully.

### Where is the license?
This project is released under the MIT license (declared in package metadata).

## License

MIT
