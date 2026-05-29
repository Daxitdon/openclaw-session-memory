# openclaw-session-memory

![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)
![no LLM](https://img.shields.io/badge/LLM-not%20required-success)
![no embeddings](https://img.shields.io/badge/embeddings-none-success)
![storage](https://img.shields.io/badge/storage-SQLite%20%2B%20FTS5-003B57?logo=sqlite&logoColor=white)
![evals](https://img.shields.io/badge/evals-gated-brightgreen)

Lossless raw session search + bookmarks + graph-lite memory for [OCPlatform](https://openclaw.ai).

A local-first replacement for noisy semantic memory. Built because the built-in
`agentmemory` mis-ranked results and silently rewrote facts. This indexes the
**raw JSONL session logs** OCPlatform already writes to disk and exposes:

- `session_search` — FTS5 full-text search over every message you've ever sent or received
- `session_recall` — pull ±N messages around a timestamp
- `session_bookmark_save` — promote durable facts/decisions/preferences/lessons to a curated layer with auto-source linking
- `session_relationship_save` — typed graph-lite relationships between entities
- gated `/context` injection — only injects high-confidence source-linked snippets when the prompt actually warrants it

Plus:
- a local dashboard at `http://127.0.0.1:13579/` (and `/memory`) with KPIs, sessions, bookmarks, entities, relationships, search, and context preview
- an eval harness (60-case search, 30-case context, +5/+5 heldout)
- backup + diagnose scripts
- audit/cleanup APIs
- temporal/supersede operations and a constrained relationship ontology

Zero LLM dependency. No embeddings. No vendor lock-in. SQLite + FTS5 only.

## Dashboard

The service ships a local dashboard at `http://127.0.0.1:13579/` (also `/memory`)
with tabs for Overview, Sessions, Bookmarks, Entities, Relationships, Search,
and Context. It shows KPIs (message/session/bookmark/entity/relationship
counts, DB size), a messages-per-day chart, breakdowns by kind/type, recent
activity, and eval/diagnose/backup status. Vanilla JS + SVG charts, no external
deps, auto-refreshes every 15s.

> Screenshots intentionally omitted — a live dashboard renders your own private
> session data. Run it locally to see yours.

## Why this exists

OCPlatform's default memory tooling was injecting fragments that shouldn't have
been there, mis-ranking lookups, and burning context. This project keeps the
raw session log as the source of truth, layers a small curated bookmark/graph
on top, and gates context injection behind a confidence threshold and a query
specificity check.

It runs as its own systemd service so it cannot break the OCPlatform gateway.

## How it compares

| | `agentmemory` (default) | LCM / lossless-claw | **openclaw-session-memory** |
|---|---|---|---|
| Source of truth | derived summaries | compacted context | **raw JSONL session logs** |
| Recall method | semantic / embeddings | LLM compaction | **deterministic FTS5** |
| Can silently rewrite facts | yes | yes | **no — raw is immutable** |
| Audit trail to original message | weak | weak | **every bookmark source-links to a line in a JSONL** |
| LLM/embedding dependency | yes | yes | **none** |
| Context injection | always-on, blind | always-on | **gated: confidence + query-specificity** |
| Mis-ranking risk | high | n/a | **low; eval-gated, 65+ cases** |
| Blast radius on gateway | in-process | in-process | **separate systemd service** |
| Graph/relationships | no | no | **typed, ontology-constrained graph-lite** |
| Temporal / supersede | no | no | **yes (valid_from/to, supersedes)** |

The origin story: the default tooling injected fragments that shouldn't have
been there and silently rewrote facts. This project trades "smart" semantic
memory for **deterministic, auditable, eval-gated** recall over data OCPlatform
already writes to disk.

## Architecture

```
~/.openclaw/agents/**/*.jsonl
         │
         ▼ (chokidar watcher)
~/.openclaw/state/session-memory.db   ←  SQLite + FTS5 + bookmarks + entities + relationships
         │
         ▼  HTTP (127.0.0.1:13579)
   /search /recall /bookmarks /entities /relationships /context /stats /audit
         │
         ▼  OCPlatform plugin (~/.openclaw/extensions/session-memory/)
   session_search · session_recall · session_bookmark_save · session_relationship_save
```

## Install (one-shot)

```bash
git clone https://github.com/Daxitdon/openclaw-session-memory.git
cd openclaw-session-memory
./install.sh --configure
```

This will:
1. `npm install`
2. backfill existing OCPlatform session JSONLs into the local SQLite DB
3. install a systemd unit at `/etc/systemd/system/session-memory.service` (root) or `~/.config/systemd/user/...` (rootless)
4. install the OCPlatform plugin to `~/.openclaw/extensions/session-memory/`
5. **with `--configure`:** back up and merge the required config into `~/.openclaw/openclaw.json` (idempotent, preserves your other plugins)

Then restart your OCPlatform gateway and you're done.

> The plugin self-registers its tools via its manifest (`activation.onStartup` +
> `contracts.tools`), so once it's enabled the tools appear without hand-listing
> them. `--configure` just flips it on and points it at the local service.

Leave off `--configure` if you'd rather wire the config yourself — the installer
then prints both the auto-configure command and the manual JSON snippet.

### Install via your agent (zero manual editing)

Paste this to your OCPlatform agent and let it do the whole setup:

```text
Install openclaw-session-memory for me.

1. git clone https://github.com/Daxitdon/openclaw-session-memory.git && cd openclaw-session-memory
2. Run ./install.sh --configure
3. Confirm the service is healthy: curl http://127.0.0.1:13579/health
4. Restart the OCPlatform gateway so the new tools (session_search, session_recall,
   session_bookmark_save, session_relationship_save) load.
5. Verify the tools are available and report back.

If my openclaw.json already sets a different memory provider, tell me before
overriding plugins.slots.memory.
```

### Manual install

```bash
npm install
SESSIONS_ROOT=~/.openclaw/agents DB_PATH=~/.openclaw/state/session-memory.db \
  node scripts/backfill.mjs
bash scripts/install-systemd.sh
bash scripts/install-plugin.sh            # prints config snippet
node scripts/configure-openclaw.mjs       # OR merge config automatically (with backup)
```

Preview the config merge without writing anything:

```bash
DRY_RUN=1 node scripts/configure-openclaw.mjs
```

## Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `13579` | HTTP service port |
| `HOST` | `127.0.0.1` | bind address (keep local; expose via Tailscale/reverse-proxy if needed) |
| `DB_PATH` | `~/.openclaw/state/session-memory.db` | SQLite DB |
| `SESSIONS_ROOT` | `~/.openclaw/agents` | recursive watch root for OCPlatform JSONL session logs |
| `REPORTS_DIR` | unset | optional dir to surface eval/diagnose results on dashboard |
| `BACKUP_DIR` | `~/.openclaw/backups/session-memory` | backup target |

## API

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | liveness, counts, db size, uptime |
| `GET /stats` | full dashboard payload (counts, time series, breakdowns) |
| `GET /search?q=…&limit=…&grouped=…` | FTS search, optional grouped/episode mode |
| `GET /recall?session_key=…&around_ts=…&window=…` | recall ±N messages |
| `GET /bookmarks?q=…&kind=…&source_type=…` | list/search bookmarks |
| `POST /bookmarks` | create durable bookmark (auto-source-links to nearest message) |
| `PATCH /bookmarks?id=…&status=archived|active|superseded` | lifecycle |
| `DELETE /bookmarks?id=…` | remove (with mention cleanup) |
| `GET /entities` / `GET /entity/mentions?q=…` | entity index |
| `GET /relationships` / `POST` / `PATCH` / `DELETE` | typed graph-lite, ontology-constrained |
| `GET /context?q=…` | preview what would be injected before an agent turn |
| `GET /audit` | summary + recent items for human review |

All endpoints are bound to `127.0.0.1` by default. Expose via Tailscale or
nginx if you need remote access.

## Plugin tools

```
session_search(query, limit?, session_key?, role?, since?, until?, trigram?, grouped?)
session_recall(session_key, around_ts, window?)
session_bookmark_save(kind, title, summary, tags?, confidence?, source_*?, status?, supersedes_id?, valid_from?, valid_to?)
session_relationship_save(from: {type, name}, rel_type, to: {type, name}, confidence?, source_*?, status?, supersedes_id?, valid_from?, valid_to?)
```

## Evals

```bash
npm run eval:search           # 60-case golden, >=98% required
npm run eval:context          # 30-case golden, >=98% required
npm run eval:search:heldout   # 5-case heldout
npm run eval:context:heldout  # 5-case heldout
npm run diagnose              # SQLite integrity + memory health
npm run backup                # DB snapshot + curated JSON
```

The eval suite has saved this project from at least three subtle regressions.
Use it before changing search ranking or context injection.

## Status

Used in production daily by one user since 2026-05-25. Mature enough to be
primary memory. Some rough edges:

- only tested against OCPlatform `2026.4.23`
- the Telegram/group runtime didn't expose `ctx.sessionManager` reliably in 4.23 so source-linking falls back to "newest message in last 15 minutes" — acceptable but not perfect
- only English text indexing; trigram FTS index helps with substrings/code

## Roadmap

- nightly health/eval/diagnose cron with regression-only reporting
- entity merge UI for duplicate entities
- `/search/debug` and `/context/debug` endpoints
- scoped/lazy rules registry

## License

MIT — see `LICENSE`.

## Acknowledgements

- Hermes (martin's session-memory idea) for the lossless-FTS-over-raw-JSONL pattern
- OpenAI Harness Engineering and Vercel's agents.md evals for the "don't add prose, add metadata and evals" lesson
- the OCPlatform community for testing and breaking things
