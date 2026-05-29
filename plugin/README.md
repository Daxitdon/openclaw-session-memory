# session-memory OCPlatform plugin

Registers four tools that talk to the local session-memory HTTP service:

- `session_search` — FTS5 search across raw OCPlatform session logs
- `session_recall` — pull ±N messages around a timestamp
- `session_bookmark_save` — promote a durable note/decision/fact/lesson
- `session_relationship_save` — typed graph-lite relationship

It also optionally injects gated source-linked context before each agent turn.

## Install

Use the parent project's installer:

```bash
bash ../scripts/install-plugin.sh
```

Or copy by hand:

```bash
mkdir -p ~/.openclaw/extensions/session-memory
cp plugin/index.mjs plugin/openclaw.plugin.json plugin/package.json \
   ~/.openclaw/extensions/session-memory/
```

Then add to `~/.openclaw/openclaw.json`:

```json
{
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
}
```

Restart OCPlatform. Verify with `openclaw --version` and check logs.

## Requirements

- session-memory service running locally (see top-level `README.md`)
- OCPlatform 2026.4.23 or compatible
