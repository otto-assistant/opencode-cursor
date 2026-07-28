#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for opencode-cursor live testing.
# Invoked from .cursor/environment.json `install`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ensure_path_line() {
  local line="$1"
  local file="$2"
  touch "$file"
  if ! grep -Fqx "$line" "$file" 2>/dev/null; then
    printf '\n%s\n' "$line" >>"$file"
  fi
}

echo "[cloud-setup] installing Bun (if needed)"
if ! command -v bun >/dev/null 2>&1 && [[ ! -x "$HOME/.bun/bin/bun" ]]; then
  curl -fsSL https://bun.sh/install | bash
fi
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"
ensure_path_line 'export BUN_INSTALL="$HOME/.bun"' "$HOME/.bashrc"
ensure_path_line 'export PATH="$BUN_INSTALL/bin:$PATH"' "$HOME/.bashrc"

echo "[cloud-setup] installing OpenCode CLI (if needed)"
if ! command -v opencode >/dev/null 2>&1 && [[ ! -x "$HOME/.opencode/bin/opencode" ]]; then
  curl -fsSL https://opencode.ai/install | bash
fi
export PATH="$HOME/.opencode/bin:$PATH"
ensure_path_line 'export PATH="$HOME/.opencode/bin:$PATH"' "$HOME/.bashrc"

echo "[cloud-setup] installing repo dependencies"
if [[ -f bun.lock ]]; then
  bun install --frozen-lockfile || bun install
else
  bun install
fi

echo "[cloud-setup] building plugin"
bun run build

echo "[cloud-setup] wiring OpenCode to local workspace plugin for live tests"
mkdir -p "$HOME/.config/opencode" "$ROOT/.opencode"

# Global config always points at the workspace build.
cat >"$HOME/.config/opencode/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file://${ROOT}"
  ],
  "provider": {
    "cursor": {
      "name": "Cursor"
    }
  },
  "model": "cursor/composer-2.5-fast"
}
EOF

# Avoid dual-loading file:// + npm pin: override project plugin config for this
# VM only, without dirtying git (skip-worktree hides the local override).
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git update-index --skip-worktree .opencode/opencode.json 2>/dev/null || true
fi
cat >"$ROOT/.opencode/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file://${ROOT}"
  ]
}
EOF

echo "[cloud-setup] versions"
command -v bun >/dev/null && bun -v || true
command -v opencode >/dev/null && opencode --version || true
command -v node >/dev/null && node -v || true

if [[ ! -f "$HOME/.local/share/opencode/auth.json" ]]; then
  echo "[cloud-setup] NOTE: Cursor OAuth not present yet."
  echo "[cloud-setup] Run once: opencode auth login --provider cursor"
  echo "[cloud-setup] Then save/update the Cloud Environment snapshot so login persists."
else
  echo "[cloud-setup] Cursor OAuth credentials found"
fi

echo "[cloud-setup] done"
