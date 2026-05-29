-- session-memory schema
CREATE TABLE IF NOT EXISTS sessions (
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

CREATE TABLE IF NOT EXISTS messages (
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

CREATE INDEX IF NOT EXISTS idx_msg_session_ts ON messages(session_key, ts);
CREATE INDEX IF NOT EXISTS idx_msg_ts ON messages(ts);

-- Graph-lite sidecar: deterministic, source-linked entity mentions.
-- Raw messages remain the source of truth; these tables are derived and rebuildable.
CREATE TABLE IF NOT EXISTS entities (
  id          INTEGER PRIMARY KEY,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  normalized  TEXT NOT NULL UNIQUE,
  first_seen  INTEGER,
  last_seen   INTEGER,
  mention_count INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS entity_aliases (
  entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias       TEXT NOT NULL,
  normalized  TEXT NOT NULL UNIQUE,
  source      TEXT NOT NULL DEFAULT 'deterministic',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS mentions (
  id          INTEGER PRIMARY KEY,
  entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id   INTEGER NOT NULL,
  session_key TEXT,
  ts          INTEGER,
  field       TEXT,
  evidence    TEXT,
  confidence  REAL NOT NULL DEFAULT 1.0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  UNIQUE(entity_id, source_type, source_id)
);

CREATE TABLE IF NOT EXISTS relationships (
  id          INTEGER PRIMARY KEY,
  from_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  rel_type    TEXT NOT NULL,
  source_type TEXT,
  source_id   INTEGER,
  confidence  REAL NOT NULL DEFAULT 0.5,
  status      TEXT NOT NULL DEFAULT 'active',
  valid_from  INTEGER,
  valid_to    INTEGER,
  supersedes_id INTEGER REFERENCES relationships(id),
  superseded_by_id INTEGER REFERENCES relationships(id),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  UNIQUE(from_entity_id, to_entity_id, rel_type, source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_mentions_entity ON mentions(entity_id);
CREATE INDEX IF NOT EXISTS idx_mentions_source ON mentions(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_mentions_session_ts ON mentions(session_key, ts);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);

CREATE TABLE IF NOT EXISTS bookmarks (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL DEFAULT 'note',
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL,
  session_key TEXT,
  ts          INTEGER,
  jsonl_path  TEXT,
  line_no     INTEGER,
  source_type TEXT NOT NULL DEFAULT 'unsourced',
  source_message_id INTEGER,
  confidence  REAL NOT NULL DEFAULT 0.7,
  promoted_by TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  valid_from  INTEGER,
  valid_to    INTEGER,
  supersedes_id INTEGER REFERENCES bookmarks(id),
  superseded_by_id INTEGER REFERENCES bookmarks(id),
  tags        TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_ts ON bookmarks(ts);
CREATE INDEX IF NOT EXISTS idx_bookmarks_kind ON bookmarks(kind);

CREATE VIRTUAL TABLE IF NOT EXISTS bookmarks_fts USING fts5(
  title,
  summary,
  tags,
  content='bookmarks', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS bookmarks_ai AFTER INSERT ON bookmarks BEGIN
  INSERT INTO bookmarks_fts(rowid, title, summary, tags)
  VALUES (new.id, new.title, new.summary, COALESCE(new.tags, ''));
END;

CREATE TRIGGER IF NOT EXISTS bookmarks_ad AFTER DELETE ON bookmarks BEGIN
  INSERT INTO bookmarks_fts(bookmarks_fts, rowid, title, summary, tags)
  VALUES('delete', old.id, old.title, old.summary, COALESCE(old.tags, ''));
END;

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content='messages', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_trigram USING fts5(
  content,
  content='messages', content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
  INSERT INTO messages_fts_trigram(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO messages_fts_trigram(messages_fts_trigram, rowid, content) VALUES('delete', old.id, old.content);
END;
