# session-memory — Hermes-style FTS5 indexer for OCPlatform

Lossless verbatim recall layer over OCPlatform session jsonls.

## Goals
1. Index every message from every session into SQLite with FTS5.
2. Sub-50ms search across millions of messages.
3. Zero LLM calls. Zero rewriting of source data.
4. No coupling to LCM or agentmemory.
5. Survives openclaw upgrades/downgrades.

## Non-goals (Phase 1)
- Semantic similarity (use agentmemory for that)
- Topic cards / curated layer (use MEMORY.md for that)
- Vector embeddings
- Cross-machine sync

## Layout
```
~/.openclaw/state/session-memory.db        # WAL-mode SQLite
~/.openclaw/agents/main/sessions/*.jsonl   # source of truth (read-only)
projects/session-memory/                   # this project
  src/
    schema.sql           # CREATE TABLE / FTS5 statements
    indexer.mjs          # tail jsonls, parse, insert
    search.mjs           # query helpers
    plugin.mjs           # openclaw plugin entry
  scripts/
    backfill.mjs         # one-time scan of existing jsonls
    bench.mjs            # query latency benchmark
```

## Schema
```sql
CREATE TABLE sessions (
  session_key TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  channel     TEXT,
  surface     TEXT,
  topic_id    TEXT,
  display     TEXT,
  first_at    INTEGER NOT NULL,
  last_at     INTEGER NOT NULL,
  msg_count   INTEGER DEFAULT 0
);

CREATE TABLE messages (
  id          INTEGER PRIMARY KEY,
  session_key TEXT NOT NULL,
  jsonl_path  TEXT NOT NULL,
  line_no     INTEGER NOT NULL,
  role        TEXT,
  msg_type    TEXT,
  ts          INTEGER NOT NULL,
  content     TEXT,
  has_image   INTEGER DEFAULT 0,
  has_tool    INTEGER DEFAULT 0,
  token_est   INTEGER,
  UNIQUE(jsonl_path, line_no)
);

CREATE INDEX idx_msg_session_ts ON messages(session_key, ts);
CREATE INDEX idx_msg_ts ON messages(ts);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  content='messages', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE messages_fts_trigram USING fts5(
  content,
  content='messages', content_rowid='id',
  tokenize='trigram'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
  INSERT INTO messages_fts_trigram(rowid, content) VALUES (new.id, new.content);
END;
```

## Content flattening rules
- `role=user` text blocks → keep as-is
- `role=assistant` text blocks → keep; `thinking` → strip (noisy); `tool_use` → `[tool:NAME args]`
- `role=toolResult` → first 1000 chars of text, base64/binary stripped
- `image` blocks → replaced with `[image]`, set `has_image=1`
- Empty content → don't index

## Tool surface (Phase 1)
- `session_search(query, opts?)` — FTS5 BM25, optional session_key/channel/since/until filters
- `session_recall(session_key, around_ts, window=10)` — fetch neighbors of a hit

## Indexer behavior
1. On start: scan all `~/.openclaw/agents/main/sessions/*.jsonl`
2. For each file: read lines, find max(line_no) already indexed, parse new lines, batch insert
3. Watch directory via chokidar (or polling fallback). On file modify, tail new lines.
4. Idempotent on `(jsonl_path, line_no)` UNIQUE constraint.

## Acceptance criteria
- [ ] Backfill of ~327MB of existing jsonls completes in <5min
- [ ] `session_search("example topic")` returns hits with snippets in <100ms
- [ ] New telegram message indexed within 5s of arrival
- [ ] DB size <100MB for current data
- [ ] No process crashes if a jsonl is malformed
- [ ] Zero impact on openclaw-gateway (separate process)
