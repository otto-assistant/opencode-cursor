# opencode-cursor-oauth

OpenCode plugin that connects to Cursor's API, giving you access to Cursor
models inside OpenCode with full tool-calling support.

## Install in OpenCode

Add this to `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-cursor-oauth"
  ],
  "provider": {
    "cursor": {
      "name": "Cursor"
    }
  }
}
```

The `cursor` provider stub is required because OpenCode drops providers that do
not already exist in its bundled provider catalog.

OpenCode installs npm plugins automatically at startup, so users do not need to
clone this repository.

## Authenticate

```sh
opencode auth login --provider cursor
```

This opens Cursor OAuth in the browser. Tokens are stored in
`~/.local/share/opencode/auth.json` and refreshed automatically.

## Use

Start OpenCode and select any Cursor model. The plugin starts a local
OpenAI-compatible proxy on demand and routes requests through Cursor's gRPC API.

## How it works

1. OAuth — browser-based login to Cursor via PKCE.
2. Model discovery — queries Cursor's gRPC API for all available models.
3. Local proxy — translates `POST /v1/chat/completions` into Cursor's
   protobuf/HTTP/2 Connect protocol.
4. Native tool routing — rejects Cursor's built-in filesystem/shell tools and
   exposes OpenCode's tool surface via Cursor MCP instead.

HTTP/2 transport runs through a Node child process (`h2-bridge.mjs`) because
Bun's `node:http2` support is not reliable against Cursor's API.

## Architecture

```
OpenCode  -->  /v1/chat/completions  -->  Bun.serve (proxy)
                                              |
                                    Node child process (h2-bridge.mjs)
                                              |
                                     HTTP/2 Connect stream
                                              |
                                    api2.cursor.sh gRPC
                                      /agent.v1.AgentService/Run
```

### Tool call flow

```
1. Cursor model receives OpenAI tools via RequestContext (as MCP tool defs)
2. Model tries native tools (readArgs, shellArgs, etc.)
3. Proxy rejects each with typed error (ReadRejected, ShellRejected, etc.)
4. Model falls back to MCP tool -> mcpArgs exec message
5. Proxy emits OpenAI tool_calls SSE chunk, pauses H2 stream
6. OpenCode executes tool, sends result in follow-up request
7. Proxy resumes H2 stream with mcpResult, streams continuation
```

## Develop locally

```sh
bun install
bun run build
bun test/smoke.ts
```

## Requirements

- [OpenCode](https://opencode.ai)
- [Bun](https://bun.sh)
- [Node.js](https://nodejs.org) >= 18 for the HTTP/2 bridge process
- Active [Cursor](https://cursor.com) subscription