#!/usr/bin/env bash
# install-plugin.sh — install OCPlatform plugin into ~/.openclaw/extensions/
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${OPENCLAW_EXTENSIONS:-$HOME/.openclaw/extensions}/session-memory"
mkdir -p "$DEST"
cp "$PROJECT_DIR/plugin/index.mjs" "$DEST/"
cp "$PROJECT_DIR/plugin/openclaw.plugin.json" "$DEST/"
cp "$PROJECT_DIR/plugin/package.json" "$DEST/"
echo "✅ plugin installed at $DEST"
echo
echo "Next: edit ~/.openclaw/openclaw.json and add:"
cat <<JSON

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
    "session_search",
    "session_recall",
    "session_bookmark_save",
    "session_relationship_save"
  ]
}
JSON
echo
echo "Then: systemctl restart openclaw-gateway.service  # or your OCPlatform process"
