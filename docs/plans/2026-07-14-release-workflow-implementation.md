# Release Workflow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement automated release workflow for `@otto-assistant/opencode-cursor-oauth` npm package.

**Architecture:** Single GitHub Actions workflow file triggered via `workflow_dispatch` with version/bump/dry_run inputs. One job with sequential steps: calculate version → test → build → commit+tag → npm publish → create GitHub Release → Discord notification.

**Tech Stack:** GitHub Actions, bun, Node.js, npm, softprops/action-gh-release

---

### Task 1: Create release workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Remove: `.github/workflows/npm-publish.yml` (replaced by new workflow)

**Step 1: Write the workflow file**

```yaml
name: Release

on:
  workflow_dispatch:
    inputs:
      version:
        description: 'Explicit version (e.g., 0.3.0). If empty, bump type is used.'
        required: false
        type: string
      bump:
        description: 'Version bump type (used if version is empty)'
        required: false
        default: 'minor'
        type: choice
        options:
          - minor
          - patch
          - major
      dry_run:
        description: 'Dry run — skip npm publish, create draft release'
        required: false
        default: false
        type: boolean

env:
  NODE_VERSION: '22'

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
          fetch-tags: true

      - name: Get current version from package.json
        id: current_version
        run: echo "version=$(node -p "require('./package.json').version")" >> "$GITHUB_OUTPUT"

      - name: Calculate new version
        id: version
        env:
          CURRENT_VERSION: ${{ steps.current_version.outputs.version }}
          INPUT_VERSION: ${{ github.event.inputs.version }}
          BUMP_TYPE: ${{ github.event.inputs.bump }}
        run: |
          set -euo pipefail
          if [[ -n "$INPUT_VERSION" ]]; then
            # Validate semver
            if ! echo "$INPUT_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
              echo "Error: version must be in semver format X.Y.Z"
              exit 1
            fi
            echo "version=$INPUT_VERSION" >> "$GITHUB_OUTPUT"
          else
            IFS='.' read -r major minor patch <<< "$CURRENT_VERSION"
            case "$BUMP_TYPE" in
              major) echo "version=$((major+1)).0.0" >> "$GITHUB_OUTPUT" ;;
              minor) echo "version=$major.$((minor+1)).0" >> "$GITHUB_OUTPUT" ;;
              patch) echo "version=$major.$minor.$((patch+1))" >> "$GITHUB_OUTPUT" ;;
              *) echo "Error: unknown bump type $BUMP_TYPE"; exit 1 ;;
            esac
          fi

      - name: Show version info
        run: |
          echo "Current: ${{ steps.current_version.outputs.version }}"
          echo "New: ${{ steps.version.outputs.version }}"
          echo "Dry run: ${{ github.event.inputs.dry_run == 'true' && 'yes' || 'no' }}"

      - name: Update package.json version
        run: |
          node -e "
            const pkg = require('./package.json');
            pkg.version = '${{ steps.version.outputs.version }}';
            require('fs').writeFileSync('./package.json', JSON.stringify(pkg, null, 2) + '\n');
          "

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          registry-url: 'https://registry.npmjs.org'

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Run tests
        run: bun run test

      - name: Build package
        run: bun run build

      - name: Commit and tag
        env:
          VERSION: ${{ steps.version.outputs.version }}
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add package.json
          # Also stage lockfile if it changed
          if git diff --name-only | grep -q bun.lock; then
            git add bun.lock
          fi
          git commit -m "chore: release v${VERSION}"
          git tag "v${VERSION}"
          git push origin "v${VERSION}"
          # Push the commit to main as well
          git push origin HEAD:main

      - name: Publish to npm
        if: ${{ github.event.inputs.dry_run != 'true' }}
        working-directory: .
        run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: v${{ steps.version.outputs.version }}
          generate_release_notes: true
          draft: ${{ github.event.inputs.dry_run == 'true' }}
          name: v${{ steps.version.outputs.version }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Send Discord notification
        if: ${{ github.event.inputs.dry_run != 'true' }}
        env:
          DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          VERSION: ${{ steps.version.outputs.version }}
          REPOSITORY: ${{ github.repository }}
        run: |
          if [ -z "$DISCORD_WEBHOOK_URL" ]; then
            echo "DISCORD_WEBHOOK_URL not set; skipping Discord notification."
            exit 0
          fi
          node - <<'NODE'
          (async () => {
            const tag = `v${process.env.VERSION}`;
            const repo = process.env.REPOSITORY;
            const releaseRes = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
              headers: {
                Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
                Accept: 'application/vnd.github+json',
              },
            });
            if (!releaseRes.ok) {
              const body = await releaseRes.text();
              throw new Error(`Failed to fetch release ${tag}: ${releaseRes.status} ${body}`);
            }
            const release = await releaseRes.json();
            const description = (release.body || `opencode-cursor-oauth ${tag} released.`).slice(0, 4096);
            const payload = {
              username: 'opencode-cursor-oauth Releases',
              embeds: [
                {
                  title: release.name || `opencode-cursor-oauth ${tag}`,
                  url: release.html_url,
                  description,
                  color: 3447003,
                  footer: { text: 'opencode-cursor-oauth Changelog' },
                },
              ],
            };
            const discordRes = await fetch(process.env.DISCORD_WEBHOOK_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            });
            if (!discordRes.ok) {
              const body = await discordRes.text();
              throw new Error(`Failed to send Discord notification: ${discordRes.status} ${body}`);
            }
            console.log('Discord notification sent successfully');
          })().catch((error) => {
            console.error(error);
            process.exit(1);
          });
          NODE
```

**Step 2: Remove old workflow**

Delete `.github/workflows/npm-publish.yml` since the new workflow supersedes it.

**Step 3: Verify**

Run: `node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/release.yml','utf8'))"` to validate YAML syntax.

### Task 2: Update AGENTS.md

**Files:**
- Modify: `AGENTS.md`

Update the Publish workflow section to reflect the new automated process.

**Step 1: Update the section**

Current text describes manual process. Replace with instructions for using the new workflow_dispatch.

**Step 2: Review**

Read the updated file to ensure correctness.
