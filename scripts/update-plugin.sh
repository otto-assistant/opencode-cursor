#!/usr/bin/env bash
#
# update-plugin.sh — Automatically pull the latest opencode-cursor-oauth plugin
#                     and restart opencode so it picks up the new version.
#
# Usage:
#   ./scripts/update-plugin.sh                  # restart on default port 36889
#   ./scripts/update-plugin.sh --port 39981     # restart on a specific port
#   ./scripts/update-plugin.sh --hostname 0.0.0.0 --port 39981
#   ./scripts/update-plugin.sh --dry-run        # only check, don't apply/restart
#
# The script:
#   1. Checks the latest `@otto-assistant/opencode-cursor-oauth` version on npm.
#   2. Git-fetches and rebases onto origin/main (auto-stashes local changes if any).
#   3. Compares the plugin pin in `.opencode/opencode.json` with the npm latest.
#   4. If the pin is stale, updates it, commits the change, and restarts opencode.
#   5. If already up-to-date, reports so and does nothing.
#

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
PLUGIN_NAME="@otto-assistant/opencode-cursor-oauth"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OPENCODE_BIN="${OPENCODE_BIN:-$(command -v opencode 2>/dev/null || echo "$HOME/.opencode/bin/opencode")}"

# Default serve flags (overridable via CLI)
PORT="${PORT:-36889}"
HOSTNAME="${HOSTNAME:-127.0.0.1}"
DRY_RUN=false

# ── Parse arguments ─────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)    PORT="$2";    shift 2 ;;
    --hostname) HOSTNAME="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --help|-h)
      sed -n '/^#$/q; /^#/p; /^$/q' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "❌ Unknown option: $1"; exit 1 ;;
  esac
done

OPENCODE_JSON="$PROJECT_DIR/.opencode/opencode.json"
PACKAGE_JSON="$PROJECT_DIR/package.json"

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[info]${NC}  $*"; }
ok()    { echo -e "${GREEN}[ok]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
err()   { echo -e "${RED}[err]${NC}   $*"; }

# ── Step 1: check npm latest ────────────────────────────────────────────────
info "Checking latest npm version of ${PLUGIN_NAME}..."
NPM_LATEST="$(npm view "${PLUGIN_NAME}" version 2>/dev/null || true)"

if [[ -z "$NPM_LATEST" ]]; then
  err "Could not fetch latest version from npm. Is the registry reachable?"
  exit 1
fi
ok "npm latest: ${NPM_LATEST}"

# ── Step 2: git pull (with stash safety) ─────────────────────────────────────
info "Fetching latest from origin/main..."

if [[ "$DRY_RUN" == true ]]; then
  ok "[dry-run] Would run: git fetch origin && git pull --rebase origin main"
else
  (
    cd "$PROJECT_DIR"

    # Stash any local uncommitted changes so git pull won't fail
    HAS_LOCAL=false
    if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
      HAS_LOCAL=true
      warn "Local changes detected — stashing them before pull"
      git stash push -m "update-plugin.sh: auto-stash before pull $(date +%Y%m%d%H%M%S)" \
        2>&1 | sed 's/^/         /'
    fi

    git fetch origin 2>&1 | sed 's/^/         /'
    # Use rebase so local commits (e.g. pin bump) are replayed on top of new remote changes
    git pull --rebase origin main 2>&1 | sed 's/^/         /'

    # Pop stash if we stashed anything
    if [[ "$HAS_LOCAL" == true ]]; then
      info "Restoring local changes from stash..."
      git stash pop 2>&1 | sed 's/^/         /' || warn "Stash pop had conflicts — resolve manually"
    fi
  )
  ok "Repository is up-to-date with origin/main"
fi

# ── Step 3: read current pin ────────────────────────────────────────────────
CURRENT_PIN="$(grep -oP "${PLUGIN_NAME}@\K[0-9]+\.[0-9]+\.[0-9]+" "$OPENCODE_JSON" 2>/dev/null || true)"

if [[ -z "$CURRENT_PIN" ]]; then
  warn "Could not extract current plugin pin from ${OPENCODE_JSON}"
  info "Expected a line like: \"${PLUGIN_NAME}@x.y.z\""
  exit 1
fi
ok "Current plugin pin: ${CURRENT_PIN}"

# ── Step 4: compare & update ────────────────────────────────────────────────
if [[ "$CURRENT_PIN" == "$NPM_LATEST" ]]; then
  ok "Plugin pin is already at ${NPM_LATEST}. Nothing to do."
  info "Reboot opencode manually if the running instance is stale."
  exit 0
fi

info "Plugin pin ${CURRENT_PIN} → ${NPM_LATEST}"

if [[ "$DRY_RUN" == true ]]; then
  ok "[dry-run] Would update ${OPENCODE_JSON}: ${CURRENT_PIN} → ${NPM_LATEST}"
  ok "[dry-run] Would commit and restart opencode"
  exit 0
fi

# ── Step 5: apply the pin update ────────────────────────────────────────────
sed -i "s|${PLUGIN_NAME}@${CURRENT_PIN}|${PLUGIN_NAME}@${NPM_LATEST}|g" "$OPENCODE_JSON"
ok "Updated ${OPENCODE_JSON}"

# Also sync package.json version if it doesn't match
PKG_VER="$(grep -oP '"version":\s*"\K[0-9]+\.[0-9]+\.[0-9]+' "$PACKAGE_JSON" || true)"
if [[ -n "$PKG_VER" && "$PKG_VER" != "$NPM_LATEST" ]]; then
  sed -i "s|\"version\": \"${PKG_VER}\"|\"version\": \"${NPM_LATEST}\"|" "$PACKAGE_JSON"
  ok "Synced package.json version: ${PKG_VER} → ${NPM_LATEST}"
fi

# ── Step 6: commit ──────────────────────────────────────────────────────────
(
  cd "$PROJECT_DIR"
  git add .opencode/opencode.json package.json 2>/dev/null
  # Only commit if there's something new
  if ! git diff --cached --quiet; then
    git commit -m "chore: bump plugin pin to ${NPM_LATEST}" 2>&1 | sed 's/^/         /'
    ok "Committed plugin pin update"
  else
    ok "No new changes to commit (pin already correct)"
  fi
)

# ── Step 7: restart opencode ────────────────────────────────────────────────
info "Restarting opencode serve..."

# Kill ALL existing opencode serve processes (they run the old plugin version)
EXISTING_PIDS="$(pgrep -f 'opencode serve' 2>/dev/null || true)"
if [[ -n "$EXISTING_PIDS" ]]; then
  # Send SIGTERM first, wait briefly, then SIGKILL survivors
  echo "$EXISTING_PIDS" | xargs -r kill 2>/dev/null || true
  sleep 2
  SURVIVORS="$(pgrep -f 'opencode serve' 2>/dev/null || true)"
  if [[ -n "$SURVIVORS" ]]; then
    echo "$SURVIVORS" | xargs -r kill -9 2>/dev/null || true
    sleep 1
  fi
  ok "Stopped old opencode serve processes"
fi

# Start a new opencode serve instance
info "Starting: ${OPENCODE_BIN} serve --hostname ${HOSTNAME} --port ${PORT}"
nohup "${OPENCODE_BIN}" serve --hostname "$HOSTNAME" --port "$PORT" \
  >> "${HOME}/.opencode-serve.log" 2>&1 &
NEW_PID=$!

# Give it a moment to start
sleep 2
if kill -0 "$NEW_PID" 2>/dev/null; then
  ok "opencode serve started (PID ${NEW_PID}) on ${HOSTNAME}:${PORT}"
  info "Logs: ~/.opencode-serve.log"
else
  err "opencode serve failed to start. Check ~/.opencode-serve.log"
  exit 1
fi

echo ""
echo -e "${GREEN}✅ Done. Plugin ${PLUGIN_NAME} updated to ${NPM_LATEST} and opencode restarted.${NC}"
