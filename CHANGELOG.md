# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.0] - 2026-08-05

### Changed

- Phase-aware stall budget for post-tool resumes: silent tool continuations recover in **90s** instead of 180s
- H2 bridge workers pre-connect TLS/HTTP-2 at startup (faster first message after restart)
- Tool-call debounce reduced from 500ms → 250ms
- Title-gen model probe result persisted to disk (skip ~2.5s Zen probe after restart)

### Added

- `OPENCODE_CURSOR_POST_TOOL_PRE_OUTPUT_STALL_TIMEOUT_MS` (default 90s)
- Regression coverage for silent post-tool stall recovery

### Performance

- First message (`gpt-5.4-nano`): **8.5s → 4.8s** (−44%)
- First message (`cursor/default`): **6.1s → 3.7s** (−39%)

## [2.1.0] - 2026-08-05

### Changed

- Phase-aware stall budgets: cold thinking gets **180s** so reasoning models are not discarded mid-thought
- Recovery limits honor `MAX_STALL_RECOVERIES`
- `proxyTelemetry` exported for observability and tests

### Added

- `OPENCODE_CURSOR_PRE_OUTPUT_STALL_TIMEOUT_MS` (default 180s)

## [2.0.0] - 2026-08-04

### Fixed

- Root-cause restate loop: tool-result follow-ups no longer look like user interrupts that discard parked bridges
- Frozen sessions: visible-text stalls surface an error in ~90s instead of holding a step for up to 12 minutes
- Infinite recovery restarts capped by forward progress
- Model discovery retries 3× on transient bridge failures

### Removed

- Accumulated loop detectors, loop-break notes, compaction re-framing, and auto-continue nudges (~1,450 lines)

## [1.4.0] - 2026-08-03

See [GitHub Releases](https://github.com/otto-assistant/opencode-cursor/releases) for earlier notes.

[2.2.0]: https://github.com/otto-assistant/opencode-cursor/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/otto-assistant/opencode-cursor/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/otto-assistant/opencode-cursor/compare/v1.4.0...v2.0.0
[1.4.0]: https://github.com/otto-assistant/opencode-cursor/releases/tag/v1.4.0
