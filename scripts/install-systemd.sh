#!/usr/bin/env bash
# install-systemd.sh — install session-memory as a user systemd service (or system if root).
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME="${SUDO_USER:-$USER}"
PORT="${PORT:-13579}"
HOST="${HOST:-127.0.0.1}"
DB_PATH="${DB_PATH:-$HOME/.openclaw/state/session-memory.db}"
SESSIONS_ROOT="${SESSIONS_ROOT:-$HOME/.openclaw/agents}"
NODE="$(command -v node)"

[ -z "$NODE" ] && { echo "node not found in PATH"; exit 1; }

mkdir -p "$(dirname "$DB_PATH")"

UNIT_PATH="/etc/systemd/system/session-memory.service"
if [ "$(id -u)" -ne 0 ]; then
  UNIT_PATH="$HOME/.config/systemd/user/session-memory.service"
  mkdir -p "$(dirname "$UNIT_PATH")"
fi

cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=OCPlatform session-memory service
After=network.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
Environment=PORT=$PORT
Environment=HOST=$HOST
Environment=DB_PATH=$DB_PATH
Environment=SESSIONS_ROOT=$SESSIONS_ROOT
ExecStart=$NODE $PROJECT_DIR/src/service.mjs
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

if [ "$(id -u)" -eq 0 ]; then
  systemctl daemon-reload
  systemctl enable --now session-memory.service
  systemctl status session-memory.service --no-pager | head -20
else
  systemctl --user daemon-reload
  systemctl --user enable --now session-memory.service
  systemctl --user status session-memory.service --no-pager | head -20
fi

echo
echo "✅ session-memory installed at $UNIT_PATH"
echo "   service: http://$HOST:$PORT/"
echo "   db:      $DB_PATH"
echo "   sessions watched: $SESSIONS_ROOT"
