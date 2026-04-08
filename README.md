# opencode-cursor-oauth

Production-ready OpenCode plugin that connects to Cursor via OAuth and runs a local OpenAI-compatible proxy with robust MCP tool-calling.

This fork focuses on reliability under real agent workloads and long, tool-heavy conversations.

## Why this fork (vs upstream)

Compared to the original [`ephraimduncan/opencode-cursor`](https://github.com/ephraimduncan/opencode-cursor), this fork adds targeted runtime hardening in the proxy layer:

- **Per-conversation request mutex** to prevent concurrent state corruption and reduce `Blob not found` failures.
- **Abort-safe stream cleanup** so locks are released correctly even when clients cancel streaming responses.
- **Bridge process lifecycle hardening** (`kill` on cleanup paths) to reduce lingering `h2-bridge` subprocesses.
- **MCP-only execution guidance** in request context so the model avoids disabled native Cursor tools and reaches useful tool execution faster.
- **Short OpenAI-compatible tool call IDs** (<=64 chars) while preserving original Cursor tool call IDs for continuation.
- **System prompt blob caching** plus blob-store synchronization to stabilize continuation after bridge interruptions.

These changes are intentionally narrow: they preserve upstream architecture and behavior while improving operational stability.

## Quick start

### 1) Install in OpenCode

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

The `cursor` provider stub is required because OpenCode drops providers not present in its bundled provider catalog.

OpenCode installs npm plugins automatically at startup, so users typically do not need to clone this repository.

### 2) Authenticate

```sh
opencode auth login --provider cursor
```

This opens Cursor OAuth in the browser. Tokens are stored in `~/.local/share/opencode/auth.json` and refreshed automatically.

### 3) Use

Start OpenCode and select any Cursor model. The plugin starts a local OpenAI-compatible proxy on demand and routes requests through Cursor's gRPC API.

## How it works

1. **OAuth (PKCE):** browser-based Cursor authentication.
2. **Model discovery:** fetches available models via Cursor gRPC.
3. **Local proxy:** maps `POST /v1/chat/completions` to Cursor protobuf/HTTP2 Connect.
4. **Tool routing:** rejects native Cursor filesystem/shell tools and exposes MCP tool execution through OpenCode.

HTTP/2 transport is handled by a Node child process (`h2-bridge.mjs`) because Bun's `node:http2` behavior is not consistently reliable against Cursor's API.

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
1. Cursor model receives OpenAI tools via RequestContext (MCP tool defs)
2. Model may attempt native tools (readArgs, shellArgs, etc.)
3. Proxy rejects native tools with typed errors
4. Model falls back to MCP tool call (mcpArgs)
5. Proxy emits OpenAI tool_calls SSE chunk and pauses H2 stream
6. OpenCode executes tool and returns tool result in follow-up request
7. Proxy resumes H2 stream with mcpResult and continues streaming
```

## Develop locally

```sh
bun install
bun run build
bun run test
```

## Requirements

- [OpenCode](https://opencode.ai)
- [Bun](https://bun.sh)
- [Node.js](https://nodejs.org) >= 18 (for the HTTP/2 bridge process)
- Active [Cursor](https://cursor.com) subscription
