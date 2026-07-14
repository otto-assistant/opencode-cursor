# Release Flow Design

## Overview
Automated release workflow for `@otto-assistant/opencode-cursor-oauth` npm package.

## Trigger
Manual via `workflow_dispatch` with inputs.

## Inputs

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `version` | string | empty | Explicit version (e.g., 0.3.0). If empty, bump type is used. |
| `bump` | choice | minor | Bump type: major, minor, patch |
| `dry_run` | boolean | false | Skip npm publish, create draft release |

## Flow (order matters)

```
 1. Checkout (with tags, full history)
 2. Calculate new version
    - Read current version from package.json
    - If version input provided: validate semver, use it
    - Else: bump major/minor/patch from current version
 3. Update package.json with new version
 4. Setup bun + Node.js
 5. bun install --frozen-lockfile
 6. bun run test
    ║  TESTS PASS? → continue
    ║  TESTS FAIL? → abort, nothing was committed/pushed
 7. bun run build
 8. git commit -m "chore: release v{VERSION}" + tag v{VERSION} + git push
 9. npm publish (skip if dry_run)
10. Create GitHub Release (skip publish step if dry_run)
    - generate_release_notes: true
    - dry_run → draft: true
    - normal → draft: false
11. Discord webhook (skip if dry_run, skip if DISCORD_WEBHOOK_URL not set)
```

## Secrets Needed
- `NPM_TOKEN` — already exists
- `DISCORD_WEBHOOK_URL` — needs to be added (optional)

## Permissions
- `contents: write` — for pushing tags and creating releases

## Files Changed
- `.github/workflows/release.yml` — new workflow (replaces or supplements npm-publish.yml)
- `package.json` — version is bumped by workflow
- `bun.lock` — may change on `bun install --frozen-lockfile`
