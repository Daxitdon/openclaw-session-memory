#!/usr/bin/env bash
# install.sh — one-shot setup: deps, service, plugin
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

echo "==> installing npm deps"
npm install --omit=dev

echo "==> initial backfill (indexes existing OCPlatform session JSONLs)"
SESSIONS_ROOT="${SESSIONS_ROOT:-$HOME/.openclaw/agents}"
DB_PATH="${DB_PATH:-$HOME/.openclaw/state/session-memory.db}"
mkdir -p "$(dirname "$DB_PATH")"
DB_PATH="$DB_PATH" SESSIONS_ROOT="$SESSIONS_ROOT" node scripts/backfill.mjs || true

echo "==> installing systemd unit"
PORT="${PORT:-13579}" HOST="${HOST:-127.0.0.1}" DB_PATH="$DB_PATH" SESSIONS_ROOT="$SESSIONS_ROOT" bash scripts/install-systemd.sh

echo "==> installing OCPlatform plugin"
bash scripts/install-plugin.sh

echo
echo "🎉 Done. Health: curl http://127.0.0.1:${PORT:-13579}/health"
