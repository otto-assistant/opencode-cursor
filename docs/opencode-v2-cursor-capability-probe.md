# OpenCode V2 Cursor capability probe

This experiment compared AgentService tool restrictions and two structured
history formats before changing the production adapter. It calls Cursor
directly through Node HTTP/2, using the repository's model selections and
protobuf definitions. The new inline history field is encoded only in the
probe.

**Current recommendation:** keep AgentService, restrict its tools to MCP, and
replay OpenCode history through structured root blobs. Preserve call/result IDs
and include explicit outcome information in the real tool-result body; the
`isError` flag alone was insufficient in the live tests. The thirty-Run screen
supported this boundary. The replacement is now implemented in the
[OpenCode-owned adapter](opencode-v2-host-owned-adapter.md), with subsequent
[integrated acceptance results](opencode-v2-release-acceptance.md). This document
records the earlier direct-protocol experiments and their limits.

## Initial live results: September 6, 2026

Structured root-blob replay became the leading candidate for the next experiment.
It recovered the random tool-result value on all three model selections. Inline
history did not pass that test. Error-result replay was unresolved at this stage.

The authorized matrix ran eighteen Runs with Node `v26.8.1`, starting at
`2026-09-06T06:54:52.450Z`. It used these discovered selections:

- Auto: `publicId=default`, `modelId=default`, no parameters, `maxMode=false`.
- Composer: `publicId=composer-2.5`, `modelId=composer-2.5`, `fast=false`,
  `maxMode=false`.
- Opus: `publicId=claude-4.6-opus-medium`, `modelId=claude-opus-4-6`,
  `thinking=false`, `context=200k`, `effort=medium`, `maxMode=false`.

Results:

- **Live tool loop: 3/3.** Each model emitted real MCP `read` and `confirm`
  execution frames and passed the value check.
- **Root-blob tool replay: 3/3.** Each fresh Run fetched three history blobs,
  emitted only `confirm`, and supplied the correct value.
- **Inline tool replay: 0/3.** Auto and Composer attempted `read` again. Opus
  completed with text and no execution frame. This establishes failure of the
  tested request shape, not that the field is universally unusable.
- **Empty toolset: 2/3 exact-output passes.** All three made zero tool calls;
  Opus's text did not exactly match `NO_TOOLS`.
- **Error replay: 0/3 for each format.** All six completed without tools, but
  failed the exact JSON/status check. Report version 1 did not distinguish
  response formatting from incorrect status reconstruction, and response text
  was not retained. These scores do not prove Cursor discarded the error flag.

Overall, eight cases passed. No native execution request was observed. There
was no unrestricted-header control, so attribute these observations to the
tested configuration rather than claiming proof that the header alone caused
them. Individual Runs took 2.4 to 10.5 seconds.

Report version 2 adds error-score categories, textual tool-marker counts, and a
distinct `tool-verification` failure. It preserves the prompts and pass
thresholds. The eighteen-Run allowance was exhausted; these diagnostic changes
have offline verification only. The original probe bundle's SHA-256 is
`090aada6a505bd8852310643f3e2c2817698cb99af9a37d4ae977f1fade6493e`.

The separate long-session failure involves Opus 4.6 **1M Thinking, max effort**,
at roughly 395k to 409k reported input tokens. It contains printed OpenCode
call/result markers in assistant text, zero corresponding tool parts, and a
`stop` finish, interleaved with genuine completed tool parts. The deterministic
probe test reproduces that distinction using neutral synthetic text. The live
matrix did not exercise that exact selection or context size.

The follow-up below addresses error-status diagnostics and the exact model.

Existing sessions can already contain simulated call/result text inside
assistant messages. Acceptance must include that contaminated history: changing
the serializer cannot turn those earlier textual claims into executed tools.

## Follow-up results: September 9, 2026 (UTC)

Twelve additional authorized Runs began at `2026-09-09T20:27:53.258Z`. Auto and
Composer retained their previous selections. The exact Opus selection was
`publicId=claude-4.6-opus-max-thinking`, `modelId=claude-opus-4-6`,
`thinking=true`, `context=1m`, `effort=max`, `maxMode=true`.

- **Outer tool-result ID did not fix error interpretation.** All six paired
  tests reported both results as successful even though one had `isError=true`.
  Some responses also contained extra formatting, but extracting the JSON did
  not correct the status. This shows the flag alone is insufficient on these
  requests; it does not establish where the server/model lost its meaning.
- **The exact Opus model passed the live tool loop and clean root replay.** It
  emitted genuine MCP execution frames and completed the nonce checks.
- **Long root replay passed at 452,093 checkpoint/context tokens in 30.671 seconds.**
  The fresh Run fetched four history blobs, emitted only `confirm`, and returned
  the value supplied in the actual tool-result entry. The large context was a
  generated reference archive, not a replay of the user's workload.
- **Short contaminated-history replay passed.** Earlier fake call/result blocks
  stayed inside an assistant-text entry. Opus used the subsequent structured
  tool result and emitted a real `confirm` call. This was a separate short test,
  not a combined long-context contamination test.
- **Explicit outcome descriptions conveyed the correct error statuses on both
  Composer and Opus.** Composer passed the strict JSON check. Opus's extracted
  JSON had the correct statuses, but surrounding formatting kept its strict
  test red. No pass threshold was relaxed.

Five of twelve strict cases passed. All twelve completed, and no unexpected
native execution request or printed OpenCode tool marker was observed. This is
diagnostic evidence, not a production success-rate measurement: six cases
deliberately tested the flag-only representation that proved insufficient.

### Integration direction

Use structured root messages as the replay boundary and keep OpenCode as the
source of truth for tools, permissions, history, and compaction. Advertise only
the current MCP snapshot. Retained Cursor Runs can optimize continuation, but
fresh replay must stand on its own.

Include explicit success/failure information derived from OpenCode's real tool
outcome in the tool-result body, alongside the error flag and paired call IDs.
Do not convert printed call/result blocks into executable calls or genuine
results. Avoid depending on the newer inline history field until a request
shape that passes replay has been demonstrated.

These experiments led to implementation in the V2 adapter and subsequent
OpenCode-level acceptance for permission denial, multiple tool rounds, parallel
calls, images, compaction, and mixed long history. See the linked acceptance
reports for those results. The original watchdog and bridge-exit failures still
require their own causal verification; this experiment did not establish their
causes.

## Run

1. Run the deterministic checks:

   ```sh
   npm run test:cursor-capability
   ```

   These use synthetic credentials and a local HTTP/2 server. They also run in
   `npm run verify`.

2. Save one to three exact discovered `CursorModelSelection` objects in a
   local JSON array. Preserve `publicId`, `modelId`, `displayName`, `parameters`,
   and `maxMode` from discovery. Use Auto/default, Composer, and a representative
   third-party model for a cross-family comparison. Keep this file outside Git.

3. Supply an authorized access token as `CURSOR_ACCESS_TOKEN` through the
   invoking process's environment, then run:

   ```sh
   npm run probe:cursor-capability -- --live --selections models.json
   ```

   The probe reads no credential store, performs no login or refresh, and sends
   only synthetic prompts. It uses normal Cursor allowance. The limit is six
   Runs per selection, eighteen total, with no retries. Each Run has a
   180-second deadline and a four-call tool limit. `--timeout-ms` can lower the
   deadline. Ctrl-C closes the active stream and stops the matrix.

For clean NDJSON output, build once with the npm command above using `--help`,
then invoke the generated file directly:

```sh
node node_modules/.cache/cursor-capability-probe.mjs --live --selections models.json > results.ndjson
```

Exit code zero requires every case to pass. The report contains selections,
case scores, termination status, observed tool/exec names, blob reads, elapsed
time, textual tool-marker counts, and reported token counts. It omits access
tokens, tool arguments, response text, and remote error payloads. A zero token
count means Cursor did not report it.

### Targeted follow-up

With a separate allowance for twelve Runs, supply a selection file containing
Auto, Composer 2.5, and Opus 4.6 1M Thinking with `effort=max`, then run:

```sh
npm run probe:cursor-capability -- --live --follow-up --selections follow-up-models.json
```

This suite performs six paired error tests across the three models, comparing
the baseline root-result shape with an added outer `id` matching
`toolCallId`. It then tests the exact Opus selection with a live tool loop,
clean replay, long replay, and replay containing earlier simulated call/result
text. The long case prepends 18,000 generated reference records and requires at
least 300,000 checkpoint/context tokens as well as a correct tool call. Finally, it
tests explicit success/error descriptions in result bodies on Composer and
Opus. Those bodies are derived from the fixture's real outcome flags.

The follow-up keeps the strict JSON pass threshold. Its diagnostics also score
an extracted JSON object and report only validated `success`/`error` labels,
allowing format errors to be distinguished from incorrect status without
recording response prose. The outer-ID comparison follows the
[reference serializer](https://github.com/can1357/oh-my-pi/blob/b2f25dbfe1e30197bae311cd8a0bccbc381f5c7b/packages/ai/src/providers/cursor.ts#L4945-L4956).

## Cases and scoring

- **Empty toolset:** send an explicitly empty `x-cursor-agent-allowed-tools`
  header and no MCP tools. Ask for shell execution if a tool is offered. Pass
  requires `NO_TOOLS`, no tool calls, and a completed turn.
- **Live tool loop:** allow only `mcp_tool_call`. Advertise `read` and `confirm`.
  The local `read` callback returns a random 192-bit value; `confirm` must receive
  that exact value. Pass requires both real execution frames in order and a
  completed turn. Neither callback accesses files or runs shell commands.
- **Root-blob tool replay:** place a synthetic user request, assistant tool
  call, and paired result in `rootPromptMessagesJson`. Start a fresh Run with
  only `Continue.` as the new message. Pass requires one `confirm` call with the
  value found only in the tool result. Repeating `read` fails.
- **Inline tool replay:** run the same scenario through
  `UserMessageAction.conversation_history`, using a new random value and fresh
  Run. Do not duplicate the transcript in the user message.
- **Root-blob error replay:** replay two calls with identical result bodies but
  opposite, randomly assigned `isError` flags. Pass requires the exact JSON
  mapping of each result's status, without new tool execution.
- **Inline error replay:** use the same error fixture through the typed history
  field on another fresh Run.

Every case requires `turn_ended`. Textual claims of tool execution do not count.
Unexpected native execs, unadvertised MCP tools, interaction queries, unknown
messages, missing blobs, stream errors, and deadlines fail the case. The probe
closes the Run rather than executing an unexpected request.

The probe uses AGENT mode, no workspace paths, and no custom system prompt,
rules, or “native tools are disabled” instruction. It supplies the MCP snapshot
both on the opening request and in request-context replies. The endpoint and
client-version header match the current adapter.

## What this can establish

A successful nonce round trip is evidence that the model used structured tool
results. A fresh-Run replay tests history independently of a parked Cursor Run.
Neither test establishes complete system-prompt ownership or production
readiness.

One matrix is a capability screen, not a reliability estimate. The two-result
error test can pass by guessing, so repeat it before relying on error semantics.
The empty-toolset check records observed behavior; it cannot inspect the hidden
tool schema offered by Cursor or establish that the header caused the behavior.

The direct-protocol screen cannot establish OpenCode permission denial, parallel
host execution, cancellation, image transport, or compaction. Those require the
separate host acceptance tests. Repeated live trials, model/tool switching, and
the original long-context workload remain broader validation work. Confirm
token accounting and usage pools independently, and preserve explicit watchdog
overrides when integrating protocol changes.

## Protocol evidence

- [Cursor SDK tool restrictions](https://cursor.com/docs/sdk/typescript#restricting-the-toolset)
  document restrictions on tools offered to the model.
- The published [SDK 1.0.31 artifact](https://registry.npmjs.org/@cursor/sdk/-/sdk-1.0.31.tgz)
  contains the allowed/excluded-tool headers and typed history descriptors.
  `UserMessageAction.conversation_history` is field 7; messages are field 1;
  user/assistant/tool variants are fields 1/2/3. Tool messages contain call ID,
  name, content, and optional `is_error` in fields 1/2/3/4.
- [cursor-rpc's reconstructed history specification](https://github.com/papodaca/cursor-rpc/blob/d30bdbf073fffb925776b1e004cb1e9def36c2b6/docs/specs/rpc_spec.md#1191-skip-the-blob-store)
  corroborates those fields. Its [continuation repair](https://github.com/papodaca/cursor-rpc/commit/782bdcd1a54fab0174bef2d38e5a3e11b5abe25b)
  is contrary evidence against assuming field presence guarantees replay.
- [oh-my-pi's Cursor provider](https://github.com/can1357/oh-my-pi/blob/b2f25dbfe1e30197bae311cd8a0bccbc381f5c7b/packages/ai/src/providers/cursor.ts)
  uses structured root messages with paired call IDs and error flags.
