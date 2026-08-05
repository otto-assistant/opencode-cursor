# Changelog

## 3.0.0

- Published the stateless successor as `@otto-assistant/opencode-cursor-auth` v3.
- Replaced the localhost proxy with a custom fetch and a stateless HTTP/2 worker.
- Added bounded PNG, JPEG, GIF, and WebP image input.
- Added structured history replay, reasoning, and OpenCode-owned tool continuation.
- Limited discovery to verified Claude, GPT, and Gemini families.
- Exposed 1M context routes as separate opt-in models alongside standard routes.
- Kept `@otto-assistant/opencode-cursor-oauth` v2 as a separate legacy package. Migration requires an explicit plugin-name change.
