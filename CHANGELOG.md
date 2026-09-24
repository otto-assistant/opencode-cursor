# Changelog

This channel targets OpenCode V2 exclusively.

## Unreleased

Live release validation remains pending for instruction precedence on Opus and
image cases, opaque-reasoning replay, and continued work after automatic
compaction, as recorded in
the [acceptance report](docs/opencode-v2-release-acceptance.md).

- Reconstruct authoritative host history through structured Cursor root blobs.
- Observe host tool, permission, question, and session events while forwarding
  results only from the next authoritative model invocation.
- Use bounded, per-Run Node HTTP/2 workers with validated Connect completion.
- Preserve late reasoning signatures in durable host metadata for fresh replay.
- Report each host step's usage as Cursor's checkpoint occupancy, counted as
  uncached input, plus that step's streamed output tokens, so OpenCode's context
  meter and compaction follow the conversation size. Keep terminal input, output,
  cache, and reasoning counters, which aggregate every model call in a Run, in
  durable provider metadata with an explicit usage scope. Verify the contract
  against the pinned host's automatic compaction behavior.
- Preserve checkpoint-referenced opaque reasoning in durable host metadata and
  restore its exact placement during replay. Reject ambiguous or changed new
  roots rather than guessing their relationship to emitted output.
- Match opaque roots to visible text and tools even when Cursor also streamed
  thinking. Omit thinking-only roots and extra unmatched conversation roots
  instead of failing a completed answer.
- Treat Cursor `reasoning-effort` as a variant parameter so Gemini 3.8 Flash
  High/Medium attach to one model, matching Gemini 3.7 Flash.
- Treat any effort-valued parameter, including `reasoning_effort`, as variants
  on one model. Keep Claude thinking on that same model: `none` is
  non-thinking, and the effort variants stay thinking. Context and fast
  listings stay separate.
- Offer Cursor only its MCP tool family when tools are enabled, using the same
  `x-cursor-agent-allowed-tools` list as the official SDK's `mcp` group, so models
  see OpenCode's tools rather than Cursor's native ones. The list includes
  `get_mcp_tools_tool_call`; allowing only `mcp_tool_call` stripped it and Cursor
  failed at bootstrap. Map any native workspace tool execution requests
  (`shellStreamArgs`, `shellArgs`, `grepArgs`, `readArgs`, `writeArgs`, `lsArgs`)
  that still arrive to OpenCode host tools and format their native results.
- Answer every Cursor exec frame. Fail unknown and unserved frames in band with
  `throw` and `streamClose` instead of leaving Cursor waiting. Decline
  Cursor-hosted web search, Exa search and fetch, web fetch, question, and
  mode-switch queries so the Run continues with host tools, return an error for
  plan creation, and fail the Run on VM setup and unrecognized queries.
- Complete native shell streams with `start`, output, `exit`, the structured
  `shellResult`, and `streamClose`. Without the result and close, Cursor kept the
  turn pending after every native shell call, so resumed Runs stalled until the
  watchdog fired.
- Decline the read and write behind Cursor's native StrReplace edit so formatted
  host reads are never written back as file content; the model edits through the
  host `edit` tool instead.
- Wait up to 180 seconds for a resumed Run's first output, as for fresh Runs.
  Cursor needed 72 to 175 seconds at large contexts, so the previous 90-second
  limit discarded continuations that would have answered.
- Open a rebuilt Run that follows tool results by saying the results answer the
  model's latest calls. The previous opener read as an interruption, and the
  model re-checked state on every rebuilt Run instead of continuing.
- Group the `minimal` effort tier into variants so models like Muse Spark 1.3
  do not leak separate `-minimal` models.
- Publish Cursor models under the stable catalog name, including newly available
  Grok models, and send the exact usable wire ID, such as `cursor-grok-4.6-xhigh`,
  as Cursor's model details id. New catalog entries appear without a plugin
  code change. When OpenCode has loaded the models.dev Cursor provider, copy
  that row's family, limits, modalities, and price. Do not copy lab caps, and
  do not replace the live account catalog with the static list.
- Add deterministic pinned-host acceptance and opt-in synthetic live probes.
- Project host system instructions into ordered Cursor rules as well as history
  roots. Add an explicit host contract that names those rules as the
  application's system prompt, gives them priority over conflicting user and
  tool text, and requires genuine tool outcomes. In live checks, Composer, Grok
  4.7, and Auto followed a project instruction over a conflicting user request
  in 18 of 18 trials, up from 6 of 9 with the earlier wording; Opus is untested.
- Restrict this package to the native V2 plugin API and its runtime dependencies.
- Migrate to released `@opencode/*` `2.0.6`, replacing the removed catalog API
  with provider source registration and reload.
- Refresh Cursor models on `credential.switched`, including sign-in and disconnect.
- Preserve tool-error metadata in structured compaction and auxiliary requests.
  Update host fixtures for directory loading and experimental session export APIs.

## 3.0.0-beta.2

- Native OpenCode V2 plugin, integration, catalog, and language-model APIs.
- Account-discovered Cursor models with exact model/variant routing.
- OpenCode-owned OAuth credentials, permissions, sessions, tools, and compaction.
