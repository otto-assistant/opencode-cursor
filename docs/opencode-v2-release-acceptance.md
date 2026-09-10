# V2 release acceptance, September 10, 2026

**Live release validation pending.** `beta` is the production compatibility channel for OpenCode
V2. Passing CI and the earlier bounded samples do not establish release
readiness. The local adapter now has best-effort host-instruction reinforcement,
opaque-reasoning persistence/replay, and the corrected usage projection. Their
remaining live checks, including continued work after automatic compaction,
are still open. Cursor support is not a prerequisite for the local implementation.

These are bounded acceptance samples, not a production reliability rate. All
live tests used OpenCode `0.0.0-beta-18050`, the built replacement adapter,
synthetic history, real OpenCode tool execution, and a loopback relay to Cursor's
OAuth AgentService endpoint. Offline tests replace Cursor with a local backend.
No private workload was replayed.

## Stepwise corrections and diagnostic follow-up

### Usage projection: corrected offline

An offline regression reproduced unnecessary compaction in the pinned host:
a Run occupying about 452k context reported 1,356,511 aggregate input tokens
against its final host invocation. The same test passes after the plugin reports
per-invocation usage as unknown for Runs spanning multiple invocations and retains
the complete terminal counters in `cursor.turnUsage` provider metadata.
The host export preserves those counters. Single-invocation Runs retain standard
usage reporting, and the existing legitimate automatic compaction test passes.
No OpenCode repository change was needed.

The tradeoff is explicit: OpenCode's built-in token/cost totals are incomplete
for multi-invocation Runs. Context occupancy is not substituted for usage, and
unknown fields are not invented or divided across steps.

### Instruction override diagnostic, 15:05 UTC

One additional Composer Run was authorized and used. The field-8 override was
rejected with `invalid_argument: unknown option '--system-prompt'`. The runner
retained the diagnostic and a failed host export. No tools or model output were
produced. The bounded billing lookup at 15:05:43 UTC found no matching row; charge
and settlement remain unknown, with the $1 reserve retained.

The production worker sends `x-cursor-client-type: cli` and
`x-cursor-client-version: cli-2026.01.09-231024f`. The inspected SDK 1.0.31 archive
sends `sdk` and `sdk-1.0.31`. The `system-sdk-composer` experiment changes only
these headers relative to the field-8 case. Its outgoing headers and error
capture passed offline validation before execution.

At 15:25 UTC, a separately authorized one-Run comparison using those SDK headers
received the same `invalid_argument: unknown option '--system-prompt'` rejection,
with no model output or tools. That header change did not fix the override path.
The billing lookup at 15:26:02 UTC found no matching row; its charge remains
unknown and its separate $1 reserve is retained. Both diagnostic allowances are
exhausted. Production headers and overrides are unchanged. Neither rejection
establishes account eligibility or why the remote service rejected the option.

Cursor's current [system-prompt documentation](https://cursor.com/docs/sdk/typescript#replacing-the-system-prompt)
says accounts without access fail with an error naming `--system-prompt`. The
observed rejection is consistent with that documented failure, but the account's
eligibility was not independently inspected and SDK API keys were not tested.
The implementation retains global rules instead of depending on this override.

### Authentication contract check

The current [SDK authentication contract](https://cursor.com/docs/sdk/typescript#authentication)
accepts user and service-account API keys. Its
[`Cursor.auth.login()` browser flow](https://cursor.com/docs/sdk/typescript#cursorauth)
mints a user API key; the SDK explicitly does not reuse credentials from a local
Cursor installation. The SDK 1.0.31 implementation exchanges that key through
`/auth/exchange_user_api_key` and forwards `systemPrompt` as
`customSystemPrompt` in its Run options.

The plugin instead uses the CLI browser flow, with `redirectTarget=cli`, and
receives access/refresh tokens through `/auth/poll`. Cursor documents
[CLI browser authentication](https://cursor.com/docs/cli/reference/authentication),
but the inspected CLI and SDK documentation does not promise system-prompt
replacement through those OAuth credentials. Sharing an exchange endpoint or
changing client headers does not establish equivalent credentials or entitlement.

The documented replacement route is therefore an account-enabled, API-key SDK
local agent. Its applicability to this plugin's OAuth path remains unconfirmed.
No new credential was minted or inspected during this contract check. An API-key
migration is not an established fix for this plugin. The local implementation
continues with the existing OAuth path and rule-based instruction delivery.

### Best-effort instruction reinforcement and opaque replay

An explicit global host-contract rule now precedes the ordered host instruction
rules. It asks the model to respect their priority, use genuine host tools, retain
truthful outcomes, and honor exact-output requirements. User messages stay in
their original roles. This improves the explicitness of instruction delivery;
it is not a measured correction of the earlier live Composer failure.

The blanket redacted-reasoning failure has been replaced with anchored replay.
Opaque data and its positions are stored in metadata-only reasoning parts. New
blocks require a final-checkpoint root whose visible content matches one emitted
assistant message. Tool IDs are normalized to their genuine host IDs before
matching. Replay restores the blocks without promoting opaque bytes to visible
text, and without retaining a separate authoritative transcript.

Focused regressions verify a late root after a real result handoff, adjacent text
coalescing, duplicate stored roots, either blob/checkpoint order, edits, model
changes, ambiguous matches, and malformed or oversized metadata. The real pinned
host preserves signed and opaque parts together through a fork and a process
restart. Live server acceptance of opaque replay remains unverified.

### Remaining boundaries

- Thinking-only opaque roots and extra unmatched conversation roots are omitted
  instead of failing a completed answer. The adapter does not guess their
  placement.
- The sustained runner now admits a second large user message, then continues
  through automatic compaction and a genuine tool that verifies the original
  nonce from retained history. Its offline fixture passes with four synthetic
  Runs. This verifies the runner and host boundary, not live model acceptance.
- The runner preserves error diagnostics and requested failure exports. Its
  offline mode rejects credentials and permits only loopback HTTP backends.

## V2-only production acceptance, 13:16 to 13:37 UTC

The package now contains only the native OpenCode V2 integration. Account
discovery uses a bounded unary Node worker; inference uses the per-Run worker.
The existing auth and model-selection assertions were retained in focused
tests. Package validation checks the single plugin export and API dependency.

Eight additional Runs were authorized and used. Seven exact
conversation-correlated billing rows total **$5.36448990** in `chargedCents`.
The rejected override Run has no matched row; its cost is unknown. Zero-valued
Composer rows do not establish zero plan consumption. These ledger values are
not a settled invoice, and no further paid Runs are authorized by this report.

### Images and system instructions

The host generated PNGs containing two randomly selected colored rectangles.
Only pixels went to the model; a real host tool checked the reported colors and
a fresh nonce. Image interpretation and both genuine tools succeeded with exact
Auto `default`, Composer `composer-2.5`, and Opus max-thinking 1M selections.
The Opus sample also persisted two reasoning signatures.

The same cases required a system-defined final marker while the user requested
a conflicting marker. These composite cases failed their strict final-output
check:

- Auto did not return the system-defined marker. The first report retained no
  diagnostic distinguishing which other answer it returned.
- Composer returned the conflicting marker, both with system history roots
  alone and after adding a global Cursor rule containing the host instructions.
- Opus included the correct marker and omitted the conflicting marker, but
  added text and failed the exact-output requirement.

The adapter now projects host system messages into ordered global
`RequestContext.rules` as well as history roots. Cursor's SDK defines this rule
schema, and the inspected community client identifies system-root-only replay
as insufficient. This projection still does **not** establish host system
precedence. The failed check remains a release blocker.

Two isolated capability experiments left the production override disabled.
`AgentRunRequest.custom_system_prompt` (field 8) received `invalid_argument`;
the diagnostic was not retained, so this does not establish its cause.
`system_prompt_spec.replace` (Run field 29, nested field 1) completed inference
but Composer still returned the conflicting marker. Request acceptance alone
does not prove that Cursor applied that field. Cursor documents full system
replacement as [account-gated](https://cursor.com/docs/sdk/typescript#replacing-the-system-prompt).

### Durable long session and compaction

The host persisted a 1.71 MB user message containing 18,000 inert records,
executed a genuine read and confirmation, and received the exact final answer.
The retained Run reported **452,300 context tokens** but **1,356,511 total input
tokens** accumulated over its internal steps. OpenCode persisted uncached input
5, cache reads 904,220, cache writes 452,286, and output 185.

The next user turn started a tool-free summary Run, which completed with
`turnEnded` and successful Connect termination. That Run reported 451,654 input
and 348 output tokens. The relay rejected the following request during
admission, before opening another paid Run. The report did not preserve the
failed assertion or final host export, so it does not prove successful durable
compaction and continuation.

These observations identified an aggregate/per-invocation usage mismatch. They
did not establish the cause of the final relay admission failure or a need to
change OpenCode. The later offline regression and plugin correction are described
above; the original live compaction sequence still lacks a final export.

The fixture now controls its follow-up tool snapshot independently of prompt
text, which compaction can rewrite, and preserves requested exports on failure.
These fixture changes have offline validation only; the live continuation
requires another authorized test.

### Live host checks, September 23

These checks ran through OpenCode `2.0.14` with the rebuilt plugin, an isolated
scratch repository, and only Cursor's own models: Composer
`composer-2.5`, Grok `grok-4.7`, and Auto `default`. Each task listed files, read
two of them, ran a failing test, fixed the bug, and re-ran the test.

- Before native shell streams were completed with `shellResult` and
  `streamClose`, every resumed Run after a shell call produced no output until
  the 180-second watchdog fired. A Composer task on a 4K-token context did not
  finish in 10 minutes. After the fix, Composer, Grok, and Auto finished the
  same task in 23 to 49 seconds, with no gaps between steps and no retries.
- With the MCP-only tool allowlist, every Run started normally and every tool
  call used OpenCode's schemas. Ranged reads of lines 900–905 returned exactly
  those lines on Composer and Grok.
- Per-step input followed checkpoint occupancy, for example 17,756 to 19,352
  tokens across a Composer loop. The first step of a new Run can still report
  no input, because Cursor's first checkpoint arrives after that step's calls.
- Before the allowlist, a native StrReplace was declined in band, and the model
  fixed the file another way without writing formatted read output into it.

Instruction precedence was rerun as a text-only version of the earlier
composite case. A project `AGENTS.md` required every reply to be exactly
`SYSTEM-7Q4`, and the user message asked for exactly `USER-3ZK`. A control
question confirmed that all three models received the instruction.

| Host contract | Composer | Grok 4.7 | Auto | Total |
| --- | --- | --- | --- | --- |
| Previous wording | 1 of 3 | 3 of 3 | 2 of 3 | 6 of 9 |
| Current wording | 6 of 6 | 6 of 6 | 6 of 6 | 18 of 18 |

The current wording names the rules as the application's system prompt rather
than the user's. The same models still completed the ordinary bug-fix task with
it. Opus and the image cases were not rerun.

### Remaining release requirements

- Rerun the composite precedence cases on Opus and with images. Cursor's own
  models pass the text-only conflict with the current host contract.
- Verify the corrected usage projection and continued genuine work after
  automatic compaction in a sustained live synthetic session.
- Validate opaque-reasoning replay against a live server when such a block is
  available. The supported anchored path passes offline; no live redacted block
  was observed in these tests.

Support claims are limited to the one exercised OAuth account and the documented
finite tool handoff window. No complete upstream batch signal or server-enforced
spending cap has been established. Exhaustive account coverage, guaranteed cache
savings, and a server-enforced spending cap are not additional release gates.

The original private workload remains outside the authorized replay scope.
An agreed equivalent synthetic workload can provide release evidence without
accessing it.

## Earlier bounded model and behavior evidence

- **Auto:** exact account-discovered `default`, no parameters, max mode off.
  A real read tool returned a fresh nonce; a second real tool verified it. The
  host persisted both successes and the expected final answer. No routed-model
  identity was reported, so the underlying model and its rate are unknown.
- **Opus:** exact `claude-4.6-opus-max-thinking` selection, requested model
  `claude-opus-4-6`, `thinking=true`, `context=1m`, `effort=max`, max mode on.
  The same two-tool loop passed on a retained Run.
- **Forced-cold recovery:** the fixture deliberately discarded each parked Run
  before the next authoritative host invocation. Three fresh Runs completed
  the same two-tool task using only host history. The first two Runs were
  intentionally abandoned and still had billing records.
- **Signed reasoning:** a retained Opus Run produced a signed assistant root.
  OpenCode persisted the late signature. Its exported synthetic session was
  imported into a newly started, isolated host. The fresh request included the
  original signed reasoning block, and Opus completed successfully. No model
  call was made during failed local import setup attempts.
- **Long mixed history:** 18,000 synthetic reference records plus paired success
  and failure results and fake printed tool markers occupied 452,381 context
  tokens. Opus selected the genuine nonce, reported the correct result statuses,
  executed the real confirmation tool, and completed. The repeated test passed
  at 452,357 tokens. Fixture elapsed times, including startup and shutdown, were
  29.3 and 36.2 seconds. The fixture supplied the archive through the host's
  context hook. This validates a large mixed prompt, not a sustained private
  workload or its next-turn compaction threshold.

Every passing logical case ended with `turnEnded`, successful Connect end
status, persisted host success, and the expected final answer. Signed reasoning
was persisted in both long cases. Those earlier cases exercised neither live
redacted reasoning nor image interpretation.

## Defects found and corrected

The first Opus test completed its tools and answer but then sent a feedback-form
notification after `turnEnded`. The older shared descriptor treated it as an
unknown terminal update, causing a false host failure. The V2 client now
recognizes that SDK-defined notification while still rejecting unknown terminal
output. Subsequent Opus tests and a deterministic regression pass.

The billing comparison also corrected usage normalization. AgentService's
`input_tokens` includes cache reads and writes. For Auto, the stream reported
10,378 total input and 7,276 cached tokens; the matched ledger row reported
3,102 uncached tokens. The adapter now subtracts cache counts to derive uncached
input instead of adding them again to the total.

Signed reasoning required a new durable metadata path because its signature
arrived after a tool result had been forwarded. The implementation validates
the referenced root, model name, block ID, and exact text digest. Later
metadata-only reasoning parts carry the signature without changing earlier
text or storing a second transcript. Offline tests cover mismatched text,
selection changes, unreferenced blobs, `doGenerate`, and host fork replay.

## Cache and cost comparison

The authorized lookup used the dashboard's read-only usage RPCs. It matched
all eleven new test Runs by exact `conversationId`, not timestamp proximity or
model name. Only matched synthetic test rows were retained.

For the same two-tool task and approximately 27k context:

- Retained execution used **one Run**, with ledger `chargedCents` equivalent to
  **$0.19116094**.
- Forced-cold execution used **three Runs**, totaling **$0.31752852**.
- Retained execution was **39.8% lower in this sample**. Both paths completed
  the same host tool contract, but their generated reasoning differed. This is
  one comparison, not a controlled estimate of a general savings percentage.

The retained Run reported 53,865 cache-read and 27,138 cache-write tokens across
its tool steps. The final forced-cold Run also reported cache reads, so fresh
reconstruction does not imply that every input token is uncached.

The first long Run reported 452,089 cache-read and 452,367 cache-write tokens;
the repeated fresh Run reported 452,090 reads and 452,343 writes. The stable
archive prefix did not produce a meaningful cross-Run saving. Their ledger
values were **$2.65546902** and **$2.65485357**, respectively. The totals are
consistent with cache reuse during each two-step tool loop, while a fresh Run
still wrote nearly the whole large prefix. Per-step cache counters were not
available to confirm that attribution directly.

Visible terminal counts and the billing ledger have different scopes. Opus
ledger rows included input/output counts beyond those in the visible stream.
The adapter therefore reports runtime tokens and context occupancy separately,
and does not turn either into a claim about settled billing. The dashboard
values include account adjustments and token fees. They are ledger-reported
consumption, not proof of a monthly invoice or incremental out-of-pocket charge.

The eleven new Runs total **$6.54350878** in ledger `chargedCents`, below the
$20 allowance. The earlier Composer canary's corrected visible list-price
estimate is $0.0042611; its ledger charge was not recovered. All twelve Runs in
the renewed allowance have been used. No further live test is authorized by
this report.

## Reproduction

Build first with `npm run build`. The opt-in runner reads credentials only from
`CURSOR_ACCESS_TOKEN` in its environment and requires an explicit account model
snapshot, allowance file, and private report destination:

```bash
node scripts/probe-opencode-v2-host.mjs --help
```

Cases include `auto`, `opus-retained`, `opus-warm`, `opus-cold`, `opus-replay`,
`long-mixed`, `long-mixed-warm`, `image-auto`, `image-composer`, `image-opus`, and
`sustained-opus`. The `system-override-composer`, `system-spec-composer`, and
`system-sdk-composer`
cases are protocol experiments, not production options. `--history` saves a
synthetic export, including an available failure snapshot, or loads an existing
export for `opus-replay`. Each case starts an isolated host. Run serially against
one allowance file.

The relay validates the exact selection, restricts tool names, reserves Run and
estimated-dollar allowance before each upstream request, and enforces input,
output, tool-count, and time bounds. Cold cases reserve three Runs; sustained
cases reserve four Runs and $28. Other cases reserve one Run each. It reports
metadata and counters, not tool
transcripts. Local
abort guards do not establish a server-enforced dollar cap. The runner now keeps
its full dollar reserve until a separate billing reconciliation, because visible
terminal counters can omit server work. Earlier runs released reserve against
stream estimates; the recorded ledger comparison supersedes those estimates.

The allowance file contains `authorizedNewRuns`, `usedNewRuns`,
`spendingAllowanceUSD`, and `reservedOrReportedUSD`. Model snapshots are arrays
of the account-discovered `CursorModel` objects. Reports and synthetic exports
must stay private because they can contain correlation identifiers, signatures,
and host paths. Billing lookup is separate from the reusable model runner.

The required offline gate remains `npm run verify`. It includes signed-root
reconstruction and the real pinned-host scheduling, permissions, cancellation,
image transport, steering, fork, compaction, and offline acceptance-runner tests.
Publication is a separate
step. The release requirements above remain open.

After these changes, `npm run verify` passed with **72 tests and 227 assertions**,
**11 offline capability tests**, source and fixture typechecks, build,
pinned-host acceptance, three offline runner cases, package validation, and loader
smoke. The packed artifact contained **59 files, 131,206 bytes**. These offline results do not
close the live release blockers above.
