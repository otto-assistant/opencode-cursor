# @otto-assistant/opencode-cursor-auth

[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](#license)

Stateless Cursor OAuth provider for OpenCode. It supports text, reasoning,
PNG, JPEG, GIF, and WebP images, plus OpenCode-owned tool loops. It does not
run a localhost OpenAI proxy or retain a Cursor conversation between requests.

## Install

```sh
npm install -g @otto-assistant/opencode-cursor-auth
```

Add the plugin to `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@otto-assistant/opencode-cursor-auth"],
  "provider": {
    "cursor": {
      "name": "Cursor"
    }
  }
}
```

Then authenticate:

```sh
opencode auth login --provider cursor
```

The login opens Cursor OAuth in a browser. OpenCode stores the credential, and
the plugin refreshes it automatically. Hosts that do not expose plugin OAuth
methods show the same browser login URL in a temporary model placeholder.

## Migrating

This package is not an automatic upgrade of
`@otto-assistant/opencode-cursor-oauth`. That package remains the separate
legacy provider.

Replace the old plugin name explicitly:

```diff
 "plugin": [
-  "@otto-assistant/opencode-cursor-oauth"
+  "@otto-assistant/opencode-cursor-auth"
 ]
```

Do not load both packages in one OpenCode configuration.

## Supported Models

The plugin discovers models available to the authenticated Cursor account. It
keeps verified Claude, GPT, and Gemini families and sends exact public model
IDs and variants without downgrading.

When Cursor advertises a one-million-token context route, the plugin exposes it
as a separate opt-in `-1m` model alongside the standard-context model. Larger
prompts can consume more Cursor account usage.

Cursor `default`, Composer, Grok, deprecated entries, and image-output models
are omitted. Unknown models and variants fail instead of falling back to
another model or endpoint.

## Images

The adapter accepts canonical base64 data URLs for PNG, JPEG/JPG, GIF, and WebP
images:

- Up to 4 images per request
- Up to 8 MiB per image
- Up to 20 MiB total image bytes
- Dimensions from 1 to 65,535 pixels per axis

Remote URLs, malformed image data, HEIC/HEIF, PDF, audio, and video return an
OpenAI-compatible `400` response. The plugin never fetches a remote image.

## Tools And History

OpenCode remains responsible for tool definitions, permission checks,
execution, persistence, and result correlation. Cursor receives MCP-shaped
descriptors but receives no native filesystem, shell, write, delete, web, or
workspace authority from this plugin.

Automatic tool choice and `tool_choice: "none"` are supported. Required or
named tool choice is rejected because no force-tool field has been verified.

Every request gets a new Cursor conversation ID and sends complete structured
history. After a tool result, OpenCode starts a fresh request containing the
original assistant call and typed result. No Cursor stream is paused while a
tool executes.

## Architecture

```text
OpenCode AI SDK
  -> @ai-sdk/openai-compatible request
  -> plugin auth.loader() custom fetch
  -> bounded UnifiedChat protobuf codec
  -> stateless Node HTTP/2 worker
  -> Cursor StreamUnifiedChatWithTools
```

The Node worker exists because OpenCode runs plugins under Bun and Cursor needs
HTTP/2. Workers pool transport connections only. They hold no conversation
state, and there is no OpenAI-facing TCP listener.

Cursor does not expose reliable usage in the verified stream fields. Usage
values returned to OpenCode are monotonic local estimates over the replayed
request and completion, not Cursor billing usage. OAuth-backed model cost
metadata is reported as zero.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
node --check src/h2-bridge-persistent.mjs
npm run pack:dry-run
```

The live protocol canary requires an inherited `CURSOR_ACCESS_TOKEN` and
consumes Cursor quota:

```sh
node scripts/probe-unified-chat.mjs
CURSOR_MODEL="gpt-5.4-medium" node scripts/probe-unified-chat.mjs
```

The canary covers text, generated PNG recognition, full-history replay, tool
generation, and typed result replay with fresh requests and conversation IDs.
It never runs in normal tests and never prints the credential. Sanitized model
evidence is stored in `test/fixtures/unified-chat-model-matrix.json`.

## Compatibility

- OpenCode 1.15.7 or newer
- Bun plugin runtime
- Node.js 18 or newer for the HTTP/2 worker
- Active Cursor subscription

## Security And Terms

This is an unofficial integration with Cursor's authenticated service. Cursor
may change the endpoint, model availability, or subscription rules without
notice. Review Cursor's current terms and your organization's policies before
use. The plugin does not log credentials or request content, including when
`OPENCODE_CURSOR_DEBUG` is enabled.

## License

MIT
