<p align="center">
  <img src="docs/header.svg" width="828" alt="opencode-cursor — Cursor models in OpenCode">
</p>

# Cursor provider for OpenCode 2

Use the models available to your Cursor account from OpenCode 2, including
Cursor private models, live model variants, image input, streaming, and tool
continuation.

This package and the `beta` branch target OpenCode V2 exclusively. The channel
name identifies the OpenCode compatibility line; users of this channel require
a complete, release-ready plugin.

## Status

**Live release validation pending.** The local adapter includes per-step usage
from Cursor's checkpoint occupancy, in-band replies to every Cursor exec frame and
hosted interaction query, and opaque-reasoning replay. Host instructions use global rules
with an explicit host contract; in live checks Cursor's own models followed them
over a conflicting user request, but precedence is not guaranteed. Short live
checks passed on WSL with Composer, Grok, and Auto; sustained automatic
compaction and the remaining release checks are still pending.
See the [acceptance report](docs/opencode-v2-release-acceptance.md) for evidence
and the remaining release requirements. The `beta` channel requires production
readiness for OpenCode V2 users.

- Plugin version: `3.0.0-beta.2`
- OpenCode: V2 with the split provider/model API
- Plugin API and test host: `@opencode/*` `2.0.6`
- Package dist-tag after publication: `beta`

OpenCode's plugin API changes between builds. This version uses `@opencode/plugin`
and the provider/model APIs introduced on September 14, 2026. It does not support
older hosts that expose `context.catalog`.

## Install

Once the beta package is published:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@otto-assistant/opencode-cursor-oauth@beta"]
}
```

Restart OpenCode after changing an npm plugin version.

For development from this repository:

```bash
bun install --frozen-lockfile
bun run build
```

Add the built directory to a V2 config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["../dist"]
}
```

Relative plugin paths are resolved from the config file containing them.

Run `npm run verify` against the pinned host. To check an installed local build
without making paid Cursor requests:

```bash
OPENCODE_CURSOR_HOST_BINARY="$(command -v opencode)" npm run test:v2-loader
OPENCODE_CURSOR_HOST_BINARY="$(command -v opencode)" npm run test:v2-host
```

## Connect Cursor

Start OpenCode 2, run `/connect`, and choose **Cursor** followed by
**Sign in with Cursor**. Open the displayed URL and approve access.

OpenCode owns credential storage and refresh. The plugin does not read or
write OpenCode credential files directly.

You need:

- An active Cursor account with model entitlement
- OpenCode 2 matching the plugin API version
- Bun for the plugin runtime
- Node.js 18 or newer for the bundled HTTP/2 workers

The Cursor desktop application and `cursor-agent` CLI are not required.

## Architecture

```text
OpenCode 2
  └─ V2 integration and provider/model APIs
       └─ native LanguageModelV3 adapter
             └─ request-scoped Node HTTP/2 worker
                 └─ Cursor AgentService
```

OpenCode owns provider selection, credentials, permissions, persistence, and
tool execution. The adapter reconstructs structured history from OpenCode's
active transcript and can retain a bounded live Run across tool steps. Late
calls remain queued for delivery. Host events keep the stream open while tools
run; results come only from the next OpenCode checkpoint. History or account
changes discard the continuation. Access and billing remain subject to the
connected Cursor account.

Host system messages also become ordered, always-apply Cursor rules. This
delivers instructions through Cursor's context mechanism, but does not establish
the same precedence as an independently controlled system prompt.

See the [adapter decision and acceptance status](docs/opencode-v2-host-owned-adapter.md)
for the implementation lifecycle, evidence, and remaining live release gates.

### Model routing

The catalog is discovered from the signed-in Cursor account. Every model and
variant carries an encoded internal selection header containing the exact
Cursor model ID, parameters, and routing mode. The native adapter validates
that header and maps it into Cursor's `RequestedModel`.

No hardcoded offline model catalog is advertised. After a connection changes,
the plugin refreshes discovery and asks OpenCode to reload the catalog.

### Lifecycle

V2 starts a Node worker lazily for each admitted Run. Disabling, reloading, or
shutting down a plugin instance stops its:

- active AgentService Runs
- HTTP/2 bridge workers
- pending OAuth polling
- catalog event subscriptions
- tool-observation subscriptions

## Development

```bash
npm test
npm run test:v2
npm run typecheck
npm run build
npm run test:v2-host
npm run test:package
npm run test:v2-loader
```

Or run the complete deterministic gate:

```bash
npm run verify
```

`test:package` packs the exact built artifact, installs only its production
dependencies with lifecycle scripts disabled, imports it independently, and
loads that extracted package through the pinned `opencode2` beta.

The [Cursor capability probe](docs/opencode-v2-cursor-capability-probe.md)
compares tool restrictions and structured history on synthetic conversations.
Its offline tests run in `verify`; live Runs require a separate invocation.

### Beta release

Before dispatching the **Release V2 Beta** workflow, land a reviewed commit that
updates `package.json` to the next unused `X.Y.Z-beta.N` version and updates any
lockfiles changed by the package manager. Run the workflow from `beta` with
`dry_run` enabled first, then rerun the same commit with `dry_run` disabled to
publish.

The workflow does not bump versions or create release commits. It validates,
packs, and publishes the exact reviewed version to npm's `beta` dist-tag.

## Debugging

Enable plugin logs:

```bash
OPENCODE_CURSOR_DEBUG=1 opencode2
```

Optional AgentService controls:

- `OPENCODE_CURSOR_NATIVE_TOOL_SETTLE_MS`
- `OPENCODE_CURSOR_NATIVE_TOOL_WAIT_MS`
- `OPENCODE_CURSOR_PRE_OUTPUT_STALL_TIMEOUT_MS`
- `OPENCODE_CURSOR_POST_TOOL_PRE_OUTPUT_STALL_TIMEOUT_MS`
- `OPENCODE_CURSOR_STALL_TIMEOUT_MS`
- `OPENCODE_CURSOR_MAX_ACTIVE_RUNS`
- `OPENCODE_CURSOR_NATIVE_PARK_TTL_MS`
- `OPENCODE_CURSOR_DEFAULT_CONTEXT_WINDOW`
- `OPENCODE_CURSOR_DEFAULT_MAX_TOKENS`

## Known beta constraints

- OpenCode V2 plugin contracts may change before stable 2.0.
- One Cursor integration currently resolves one active OpenCode credential.
- Real account acceptance consumes Cursor quota and is run separately from
  deterministic CI.
- Models without explicit Cursor context metadata use the configurable default
  context and output limits listed above.
- The plugin relies on Cursor's private API, which can change without notice.
- The replacement has offline host acceptance and live Composer/Auto/Opus,
  signed-reasoning restart, 452k mixed-history, and billing-comparison evidence.
  Retained Runs reported cache reads; fresh long Runs did not show a warm-replay
  saving. See the [release acceptance report](docs/opencode-v2-release-acceptance.md).
- Each step reports Cursor's checkpoint occupancy as input and its streamed output
  tokens as output, so OpenCode's context meter and compaction follow the
  conversation size. Cursor exposes no per-call cache split, so occupancy counts
  as uncached input and OpenCode's cost estimate is an upper bound on long tool
  loops. Exact Run counters, including cache reads and writes, are retained in
  `cursor.turnUsage` provider metadata.
- Cursor's built-in tools are hidden, so models use OpenCode's tools. Native
  requests that still arrive are mapped to host tools, except StrReplace, which is
  declined because it would write formatted host reads back into files.
- Signed and opaque reasoning have offline-verified persistence and restart
  replay. Opaque blocks retain their exact data and placement, anchored to one
  unchanged assistant message. Thinking-only and other unmatched checkpoint roots
  are omitted instead of failing the turn.
  Signed reasoning also has live replay evidence; opaque reasoning does not yet.
- Host instructions are sent as ordered global rules and genuine system-history
  roots, with an explicit rule for instruction priority and real host-tool use.
  This is best-effort delivery, not verified replacement of Cursor's system prompt.
  In live checks, Composer, Grok 4.7, and Auto followed a project instruction
  over a conflicting user request in 18 of 18 trials.

## License

MIT
