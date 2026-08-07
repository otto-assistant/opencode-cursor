<p align="center">
  <img src="docs/header.svg" width="828" alt="opencode-cursor — Cursor models in OpenCode, direct API, native OAuth">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@otto-assistant/opencode-cursor-oauth"><img src="https://img.shields.io/npm/v/%40otto-assistant%2Fopencode-cursor-oauth?style=flat-square&color=3dd6c6&labelColor=0b1220&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@otto-assistant/opencode-cursor-oauth"><img src="https://img.shields.io/npm/dm/%40otto-assistant%2Fopencode-cursor-oauth?style=flat-square&color=3dd6c6&labelColor=0b1220" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3dd6c6?style=flat-square&labelColor=0b1220" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/linux%20·%20macos%20·%20windows-3dd6c6?style=flat-square&labelColor=0b1220" alt="linux, macos, windows">
  <a href="https://github.com/otto-assistant/opencode-cursor/releases"><img src="https://img.shields.io/github/v/release/otto-assistant/opencode-cursor?style=flat-square&color=3dd6c6&labelColor=0b1220&label=release" alt="latest release"></a>
</p>

<p align="center">
  <strong>Cursor models inside OpenCode</strong> — browser OAuth, live catalog discovery,<br>
  and a local OpenAI-compatible proxy tuned for agent loops.
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#authenticate">Authenticate</a> ·
  <a href="#why-this-plugin">Why this plugin</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

Use every model on your Cursor subscription from OpenCode: Claude, GPT, Gemini, Grok, Composer, and Cursor Auto — with thinking, effort variants, streaming, and tool calls that actually finish.

No `cursor-agent` binary. No SDK child-process gymnastics. Direct Cursor API over HTTP/2.

## Install

```bash
npm install -g @otto-assistant/opencode-cursor-oauth
```

Add the plugin to `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@otto-assistant/opencode-cursor-oauth"],
  "provider": {
    "cursor": { "name": "Cursor" }
  }
}
```

Or build from source:

```bash
git clone https://github.com/otto-assistant/opencode-cursor.git
cd opencode-cursor
bun install && bun run build
npm install -g .
```

## Authenticate

```bash
opencode auth login --provider cursor
```

A browser window opens Cursor OAuth. Tokens land in `~/.local/share/opencode/auth.json` and refresh automatically.

Then start OpenCode, pick provider **cursor**, and choose a model (including Thinking / Fast / effort variants when Cursor exposes them).

```bash
opencode run "Summarise this repository in five bullets." --model cursor/default
```

## Why this plugin

| | |
|---|---|
| **Direct API** | Talks to Cursor over HTTP/2. No `cursor-agent` install, no brittle CLI wrapper. |
| **Native OAuth** | `opencode auth login` — PKCE browser flow with automatic token refresh. |
| **Live models** | Discovers your account's catalog, including Thinking, Fast, 1M context, and effort levels. |
| **Agent-grade streaming** | Tool calls continue correctly; parked bridges resume with results instead of restating forever. |
| **Phase-aware stalls** | Reasoning gets time to think; silent post-tool hangs recover in ~90s, not minutes. |
| **Measured speed** | v2.2: first message **−39% to −44%** TTFB vs prior release (cold start + H2 pre-connect). |

## Architecture

```text
OpenCode
  └─ /v1/chat/completions
       └─ Bun.serve proxy
            └─ Node HTTP/2 bridge
                 └─ Cursor API (api2.cursor.sh)
```

Model listings map Cursor's variant catalog into OpenCode-native choices (`Opus 4.8`, `Opus 4.8 Thinking`, effort `low`→`max`, Fast, …). Selection is encoded for the proxy so Cursor receives the exact `RequestedModel` parameters your account supports.

## Performance notes

From the [v2.2.0](https://github.com/otto-assistant/opencode-cursor/releases/tag/v2.2.0) release:

| Scenario | Before | After |
|---|---|---|
| First message, `gpt-5.4-nano` | 8.5s | **4.8s** |
| First message, `cursor/default` | 6.1s | **3.7s** |
| Post-tool silent stall budget | 180s | **90s** |

Knobs (optional): `OPENCODE_CURSOR_PRE_OUTPUT_STALL_TIMEOUT_MS`, `OPENCODE_CURSOR_POST_TOOL_PRE_OUTPUT_STALL_TIMEOUT_MS`, `OPENCODE_CURSOR_TOOL_DEBOUNCE_MS`.

## Requirements

- [OpenCode](https://opencode.ai)
- Active Cursor subscription
- Bun (plugin runtime) · Node.js ≥ 18 (HTTP/2 bridge)

## Development

```bash
bun install
bun run build
bun run test
```

## FAQ

**Do I need to clone the repo?**  
No. Configure the npm package in `opencode.json` and OpenCode installs it.

**Is this the same as cursor-agent bridges?**  
No. This plugin authenticates with Cursor OAuth and proxies the Cursor API directly. You do not need the `cursor-agent` CLI.

**Where are releases?**  
[GitHub Releases](https://github.com/otto-assistant/opencode-cursor/releases) · [npm](https://www.npmjs.com/package/@otto-assistant/opencode-cursor-oauth) · [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
