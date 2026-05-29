#!/usr/bin/env bash
# install-plugin.sh — install OCPlatform plugin into ~/.openclaw/extensions/
#   --configure   also merge config into ~/.openclaw/openclaw.json (with backup)
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${OPENCLAW_EXTENSIONS:-$HOME/.openclaw/extensions}/session-memory"
mkdir -p "$DEST"
cp "$PROJECT_DIR/plugin/index.mjs" "$DEST/"
cp "$PROJECT_DIR/plugin/openclaw.plugin.json" "$DEST/"
cp "$PROJECT_DIR/plugin/package.json" "$DEST/"
echo "✅ plugin installed at $DEST"

if [ "${1:-}" = "--configure" ]; then
  echo
  echo "==> configuring ~/.openclaw/openclaw.json (backup will be created)"
  node "$PROJECT_DIR/scripts/configure-openclaw.mjs"
  exit 0
fi

echo
echo "The plugin self-registers its tools via its manifest (activation.onStartup)."
echo "To enable it, run ONE of:"
echo
echo "  A) Auto-configure (recommended):"
echo "       node scripts/configure-openclaw.mjs       # backs up + merges your openclaw.json"
echo "     or re-run install with:  bash scripts/install-plugin.sh --configure"
echo
echo "  B) Manual — add to ~/.openclaw/openclaw.json:"
cat <<'JSON'

"plugins": {
  "slots": { "memory": "session-memory" },
  "entries": {
    "session-memory": {
      "enabled": true,
      "config": {
        "base_url": "http://127.0.0.1:13579",
        "timeout_ms": 3000,
        "inject_context": true,
        "context_min_confidence": 0.42,
        "context_limit": 5
      }
    }
  }
},
"tools": {
  "alsoAllow": [
    "session_search", "session_recall",
    "session_bookmark_save", "session_relationship_save"
  ]
}
JSON
echo
echo "Then restart your OCPlatform gateway."
