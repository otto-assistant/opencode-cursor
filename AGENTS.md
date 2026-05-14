# AGENTS

## Repository Rules

- Publish/deploy is performed via GitHub Actions only.
- Do not run `npm publish` manually from local/agent sessions unless explicitly requested by the user.

## OpenCode plugin pin

- Keep `.opencode/opencode.json` in sync with the npm version in `package.json` (same `@otto-assistant/opencode-cursor-oauth@x.y.z`).
- When cutting a release, bump `package.json`, update the plugin line in `.opencode/opencode.json`, commit both together unless the user says otherwise.

## GitHub CLI (`gh`) for this repo

- This checkout may have `upstream` set to `ephraimduncan/opencode-cursor`; `gh` can default to that fork and return 404 for releases.
- For releases and Actions, always pass an explicit repo: `--repo otto-assistant/opencode-cursor` (e.g. `gh release create`, `gh run list`, `gh run watch`).

## Publish workflow (when the user asks to publish)

1. Bump `package.json` version; align `.opencode/opencode.json` plugin version.
2. Run `bun install --frozen-lockfile`, `bun run test`, `bun run build`.
3. Commit release files, push `main`.
4. Create the GitHub release with tag `v<version>` using `gh release create ... --repo otto-assistant/opencode-cursor` so `Publish npm package` runs.
5. Wait for that workflow to succeed; confirm with `npm view @otto-assistant/opencode-cursor-oauth version`.

Do not ask whether to use the Otto org repo or whether to bump the local plugin pin—follow the above by default.
