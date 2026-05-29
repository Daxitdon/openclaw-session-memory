#!/usr/bin/env bash
# bootstrap.sh — clone + install openclaw-session-memory in one line.
#
#   curl -fsSL https://raw.githubusercontent.com/Daxitdon/openclaw-session-memory/main/bootstrap.sh | bash
#
# Flags are passed straight through to install.sh, e.g.:
#   curl -fsSL .../bootstrap.sh | bash -s -- --no-configure
#
# Prefer to read before you run? (recommended for any curl|bash):
#   git clone https://github.com/Daxitdon/openclaw-session-memory.git
#   cd openclaw-session-memory && ./install.sh
set -euo pipefail

REPO="${SESSION_MEMORY_REPO:-https://github.com/Daxitdon/openclaw-session-memory.git}"
REF="${SESSION_MEMORY_REF:-main}"
# Persistent clone location (so the systemd unit's WorkingDirectory survives).
DEST="${SESSION_MEMORY_DIR:-$HOME/.openclaw/openclaw-session-memory}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ required tool not found: $1" >&2; exit 1; }; }
need git
need node
need npm

echo "==> openclaw-session-memory bootstrap"
echo "    repo: $REPO ($REF)"
echo "    dir:  $DEST"

if [ -d "$DEST/.git" ]; then
  echo "==> existing checkout found — updating"
  git -C "$DEST" fetch --depth 1 origin "$REF"
  git -C "$DEST" checkout -q "$REF"
  git -C "$DEST" reset -q --hard "origin/$REF"
else
  mkdir -p "$(dirname "$DEST")"
  echo "==> cloning"
  git clone --depth 1 --branch "$REF" "$REPO" "$DEST"
fi

cd "$DEST"
chmod +x install.sh 2>/dev/null || true
echo "==> running install.sh $*"
exec ./install.sh "$@"
