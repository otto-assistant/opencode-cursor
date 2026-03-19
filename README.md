# opencode-cursor-auth

OpenCode plugin that connects to Cursor's API, giving you access to all Cursor
models (Composer 2, Claude, GPT, Gemini, etc.) inside OpenCode with full tool
calling support.

## How it works

1. **OAuth** -- Browser-based login to your Cursor account via PKCE flow.
2. **Model discovery** -- Queries Cursor's gRPC API for all available models.
3. **Local proxy** -- Starts a localhost OpenAI-compatible server that translates
   `POST /v1/chat/completions` into Cursor's protobuf/HTTP2 Connect protocol.
4. **Native tool routing** -- Cursor models try their built-in tools first (read,
   shell, grep, etc.). The proxy rejects those and exposes OpenCode's tools via
   Cursor's MCP protocol instead.

HTTP/2 transport runs through a Node child process (`h2-bridge.mjs`) because
Bun's `node:http2` module is broken.

## Setup

### 1. Install dependencies

```sh
cd opencode-cursor
bun install
```

### 2. Register the plugin

Add to `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": [
    // ... other plugins
    "file:///path/to/opencode-cursor/src/index.ts"
  ],
  "provider": {
    // ... other providers
    "cursor": {
      "name": "Cursor"
    }
  }
}
```

The `cursor` provider stub is required -- OpenCode's `mergeProvider()` silently
drops providers not in the models.dev database unless a config entry exists.

### 3. Authenticate

```sh
opencode auth login --provider cursor
```

Opens a browser window for Cursor OAuth. Tokens are stored in
`~/.local/share/opencode/auth.json` and refreshed automatically.

### 4. Use

Start OpenCode and select any Cursor model. The proxy starts on a random port
when the plugin loads.

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
4. Model falls back to MCP tool → mcpArgs exec message
5. Proxy emits OpenAI tool_calls SSE chunk, pauses H2 stream
6. OpenCode executes tool, sends result in follow-up request
7. Proxy resumes H2 stream with mcpResult, streams continuation
```

## Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Plugin entry -- auth hook, model injection, proxy lifecycle |
| `src/proxy.ts` | OpenAI-to-Cursor translator, native tool rejection, MCP bridging |
| `src/h2-bridge.mjs` | Node child process for HTTP/2 bidirectional streaming |
| `src/auth.ts` | Cursor OAuth (PKCE, polling, token refresh) |
| `src/models.ts` | Model discovery via gRPC `GetUsableModels` |
| `src/pkce.ts` | PKCE verifier/challenge generation |
| `src/proto/agent_pb.ts` | Cursor protobuf definitions (generated) |
| `test/smoke.ts` | Proxy, auth, and plugin shape tests |

## Tests

```sh
bun test/smoke.ts
```

## Requirements

- [Bun](https://bun.sh) (runtime)
- [Node.js](https://nodejs.org) >= 18 (for HTTP/2 bridge)
- Active [Cursor](https://cursor.com) subscription
