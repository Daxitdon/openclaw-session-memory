// session-memory HTTP service + watcher
import http from 'node:http';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { URL } from 'node:url';
import { Searcher } from './search.mjs';
import { startWatcher } from './watcher.mjs';
import { UI_HTML } from './ui.mjs';
import { ensureEntityStatements, indexEntitiesForSource } from './entities.mjs';
import { buildContext } from './context.mjs';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 13579);
const DB_PATH = process.env.DB_PATH || (process.env.HOME + '/.openclaw/state/session-memory.db');

const startedAt = Date.now();

function logJson(obj) {
  process.stderr.write(JSON.stringify({ ts: Date.now(), ...obj }) + '\n');
}

// Start watcher (also opens its own write DB connection)
startWatcher({ dbPath: DB_PATH });

// Searcher uses readonly connection — safe alongside watcher's WAL writes
const searcher = new Searcher(DB_PATH, { readonly: true });
const writerDb = new Database(DB_PATH);
writerDb.pragma('journal_mode = WAL');
const entityStmts = ensureEntityStatements(writerDb);

const ALLOWED_REL_TYPES = new Set([
  'PREFERS','USES','OWNS','DEPENDS_ON','CAUSED_ISSUES_WITH','HAS_STALE_LOGGING_TABLES',
  'REPLACES_PRIMARY_USE_OF','REQUIRES_APPROVAL_FOR','DEPLOYED_ON','PART_OF','SAME_AS',
  'MENTIONS','TOUCHED','INITIATED_BY','WORKS_ON','HAS_RULE','HAS_STATUS','BLOCKED_BY',
]);

function ensureColumns(db, table, specs) {
  const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
  for (const [name, sql] of specs) if (!cols.has(name)) db.exec(sql);
}

function ensureBookmarkColumns(db) {
  ensureColumns(db, 'bookmarks', [
    ['source_type', "ALTER TABLE bookmarks ADD COLUMN source_type TEXT NOT NULL DEFAULT 'unsourced'"],
    ['source_message_id', 'ALTER TABLE bookmarks ADD COLUMN source_message_id INTEGER'],
    ['confidence', 'ALTER TABLE bookmarks ADD COLUMN confidence REAL NOT NULL DEFAULT 0.7'],
    ['promoted_by', 'ALTER TABLE bookmarks ADD COLUMN promoted_by TEXT'],
    ['status', "ALTER TABLE bookmarks ADD COLUMN status TEXT NOT NULL DEFAULT 'active'"],
    ['valid_from', 'ALTER TABLE bookmarks ADD COLUMN valid_from INTEGER'],
    ['valid_to', 'ALTER TABLE bookmarks ADD COLUMN valid_to INTEGER'],
    ['supersedes_id', 'ALTER TABLE bookmarks ADD COLUMN supersedes_id INTEGER'],
    ['superseded_by_id', 'ALTER TABLE bookmarks ADD COLUMN superseded_by_id INTEGER'],
  ]);
  ensureColumns(db, 'relationships', [
    ['status', "ALTER TABLE relationships ADD COLUMN status TEXT NOT NULL DEFAULT 'active'"],
    ['valid_from', 'ALTER TABLE relationships ADD COLUMN valid_from INTEGER'],
    ['valid_to', 'ALTER TABLE relationships ADD COLUMN valid_to INTEGER'],
    ['supersedes_id', 'ALTER TABLE relationships ADD COLUMN supersedes_id INTEGER'],
    ['superseded_by_id', 'ALTER TABLE relationships ADD COLUMN superseded_by_id INTEGER'],
  ]);
  db.exec('CREATE INDEX IF NOT EXISTS idx_bookmarks_status ON bookmarks(status); CREATE INDEX IF NOT EXISTS idx_relationships_status ON relationships(status);');
}
ensureBookmarkColumns(writerDb);

const stmtCounts = searcher.db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM messages) AS message_count,
    (SELECT COUNT(*) FROM sessions) AS session_count
`);

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

function resolveSourceMessageId(b) {
  if (Number.isFinite(Number(b.source_message_id))) return Number(b.source_message_id);
  if (Number.isFinite(Number(b.source_id))) return Number(b.source_id);
  if (b.jsonl_path && Number.isFinite(Number(b.line_no))) {
    const row = writerDb.prepare('SELECT id FROM messages WHERE jsonl_path = ? AND line_no = ?').get(String(b.jsonl_path), Number(b.line_no));
    if (row?.id) return Number(row.id);
  }
  return null;
}

function isLocal(req) {
  const ra = req.socket.remoteAddress || '';
  return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
}

function dbSize() {
  try { return fs.statSync(DB_PATH).size; } catch { return null; }
}

function handleHealth(_req, res) {
  const counts = stmtCounts.get();
  sendJson(res, 200, {
    ok: true,
    db_path: DB_PATH,
    db_size_bytes: dbSize(),
    message_count: counts.message_count,
    session_count: counts.session_count,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    port: PORT,
  });
}

function parseIntOr(v, d) {
  if (v == null || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function handleSearch(url, res) {
  const q = url.searchParams.get('q');
  if (!q) return sendJson(res, 400, { error: 'missing q' });
  const opts = {
    limit: parseIntOr(url.searchParams.get('limit'), 10),
    session_key: url.searchParams.get('session_key') || undefined,
    channel: url.searchParams.get('channel') || undefined,
    role: url.searchParams.get('role') || undefined,
    since: url.searchParams.get('since') ? parseIntOr(url.searchParams.get('since'), undefined) : undefined,
    until: url.searchParams.get('until') ? parseIntOr(url.searchParams.get('until'), undefined) : undefined,
    trigram: url.searchParams.get('trigram') === '1',
    include_checkpoints: url.searchParams.get('include_checkpoints') === '1',
    grouped: url.searchParams.get('grouped') === '1',
    windowMs: url.searchParams.get('window_ms') ? parseIntOr(url.searchParams.get('window_ms'), undefined) : undefined,
    maxContext: url.searchParams.get('max_context') ? parseIntOr(url.searchParams.get('max_context'), undefined) : undefined,
  };
  try {
    const rows = opts.grouped ? searcher.searchGrouped(q, opts) : searcher.search(q, opts);
    sendJson(res, 200, rows);
  } catch (e) {
    sendJson(res, 500, { error: String(e && e.message || e) });
  }
}

function handleRecall(url, res) {
  const session_key = url.searchParams.get('session_key');
  const around_ts = parseIntOr(url.searchParams.get('around_ts'), null);
  if (!session_key || around_ts == null) {
    return sendJson(res, 400, { error: 'session_key and around_ts required' });
  }
  const window = parseIntOr(url.searchParams.get('window'), 10);
  try {
    const rows = searcher.recall(session_key, around_ts, window);
    sendJson(res, 200, rows);
  } catch (e) {
    sendJson(res, 500, { error: String(e && e.message || e) });
  }
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (Buffer.byteLength(data) > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function handleBookmarks(url, res) {
  const q = url.searchParams.get('q');
  const limit = parseIntOr(url.searchParams.get('limit'), 20);
  try {
    if (q) {
      const rows = searcher.searchBookmarks(q, { limit });
      return sendJson(res, 200, rows);
    }
    const conds = [];
    const params = [];
    if (url.searchParams.get('kind')) { conds.push('kind = ?'); params.push(url.searchParams.get('kind')); }
    if (url.searchParams.get('source_type')) { conds.push('source_type = ?'); params.push(url.searchParams.get('source_type')); }
    if (url.searchParams.get('max_confidence')) { conds.push('confidence <= ?'); params.push(parseIntOr(url.searchParams.get('max_confidence'), 1)); }
    params.push(limit);
    const rows = searcher.db.prepare(`
      SELECT * FROM bookmarks
      ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
      ORDER BY COALESCE(ts, created_at) DESC, id DESC
      LIMIT ?
    `).all(...params);
    sendJson(res, 200, rows);
  } catch (e) {
    sendJson(res, 500, { error: String(e && e.message || e) });
  }
}

function readLatestJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function handleStats(_url, res) {
  try {
    const counts = searcher.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM messages) AS messages,
        (SELECT COUNT(*) FROM sessions) AS sessions,
        (SELECT COUNT(*) FROM bookmarks) AS bookmarks,
        (SELECT COUNT(*) FROM bookmarks WHERE status='active') AS bookmarks_active,
        (SELECT COUNT(*) FROM bookmarks WHERE source_type='unsourced') AS bookmarks_unsourced,
        (SELECT COUNT(*) FROM bookmarks WHERE confidence<=0.45) AS bookmarks_lowconf,
        (SELECT COUNT(*) FROM entities) AS entities,
        (SELECT COUNT(*) FROM mentions) AS mentions,
        (SELECT COUNT(*) FROM relationships) AS relationships,
        (SELECT COUNT(*) FROM relationships WHERE status='active') AS relationships_active
    `).get();
    const bookmarks_by_kind = searcher.db.prepare("SELECT kind, COUNT(*) AS n FROM bookmarks GROUP BY kind ORDER BY n DESC").all();
    const bookmarks_by_status = searcher.db.prepare("SELECT status, COUNT(*) AS n FROM bookmarks GROUP BY status ORDER BY n DESC").all();
    const bookmarks_by_source = searcher.db.prepare("SELECT source_type, COUNT(*) AS n FROM bookmarks GROUP BY source_type ORDER BY n DESC").all();
    const entities_by_type = searcher.db.prepare("SELECT type, COUNT(*) AS n FROM entities GROUP BY type ORDER BY n DESC LIMIT 12").all();
    const rels_by_type = searcher.db.prepare("SELECT rel_type, COUNT(*) AS n FROM relationships GROUP BY rel_type ORDER BY n DESC").all();
    const now = Date.now();
    const since30 = now - 30 * 86400000;
    const messages_per_day = searcher.db.prepare(`
      SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') AS day, COUNT(*) AS n
      FROM messages WHERE ts >= ? GROUP BY day ORDER BY day
    `).all(since30);
    const sessions_top = searcher.db.prepare(`
      SELECT session_key, agent_id, channel, topic_id, msg_count, first_at, last_at
      FROM sessions ORDER BY last_at DESC LIMIT 25
    `).all();
    const recent_bookmarks = searcher.db.prepare(`
      SELECT id, kind, title, source_type, session_key, ts, confidence, status, created_at
      FROM bookmarks ORDER BY created_at DESC LIMIT 15
    `).all();
    const recent_relationships = searcher.db.prepare(`
      SELECT r.id, fe.name AS from_name, fe.type AS from_type, r.rel_type, te.name AS to_name, te.type AS to_type,
             r.source_type, r.confidence, r.status, r.created_at
      FROM relationships r
      JOIN entities fe ON fe.id = r.from_entity_id
      JOIN entities te ON te.id = r.to_entity_id
      ORDER BY r.created_at DESC LIMIT 15
    `).all();
    const top_entities = searcher.db.prepare(`
      SELECT id, type, name, mention_count, last_seen
      FROM entities ORDER BY mention_count DESC, last_seen DESC LIMIT 20
    `).all();
    const REPORTS_DIR = process.env.REPORTS_DIR || '';
    const evalSearchRaw = REPORTS_DIR ? readLatestJson(`${REPORTS_DIR}/session-memory-evals/latest.json`) : null;
    const evalContextRaw = REPORTS_DIR ? readLatestJson(`${REPORTS_DIR}/session-memory-context-evals/latest.json`) : null;
    const diagnoseRaw = REPORTS_DIR ? readLatestJson(`${REPORTS_DIR}/session-memory-diagnose/latest.json`) : null;
    const evalSearch = evalSearchRaw?.summary || evalSearchRaw;
    const evalContext = evalContextRaw?.summary || evalContextRaw;
    const diagnose = diagnoseRaw ? {
      ok: diagnoseRaw.summary?.ok ?? diagnoseRaw.ok,
      critical: diagnoseRaw.summary?.critical_count ?? diagnoseRaw.critical_count ?? 0,
      warnings: diagnoseRaw.summary?.warning_count ?? diagnoseRaw.warning_count ?? 0,
      ts: diagnoseRaw.generated_at ? Date.parse(diagnoseRaw.generated_at) : null,
    } : null;
    let lastBackup = null;
    try {
      const dir = process.env.BACKUP_DIR || '';
      if (!dir) { /* no backup dir configured */ }
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.db'));
      const stats = files.map(f => ({ f, t: fs.statSync(`${dir}/${f}`).mtimeMs })).sort((a,b)=>b.t-a.t);
      if (stats[0]) lastBackup = { file: stats[0].f, ts: stats[0].t };
    } catch {}
    sendJson(res, 200, {
      ok: true,
      now,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      db_path: DB_PATH,
      db_size_bytes: dbSize(),
      counts,
      bookmarks_by_kind,
      bookmarks_by_status,
      bookmarks_by_source,
      entities_by_type,
      rels_by_type,
      messages_per_day,
      sessions_top,
      recent_bookmarks,
      recent_relationships,
      top_entities,
      eval_search: evalSearch,
      eval_context: evalContext,
      diagnose,
      last_backup: lastBackup,
    });
  } catch (e) {
    sendJson(res, 500, { error: String(e && e.message || e) });
  }
}

function handleAudit(url, res) {
  try {
    const summary = searcher.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM bookmarks) AS bookmarks,
        (SELECT COUNT(*) FROM bookmarks WHERE source_type = 'unsourced') AS unsourced_bookmarks,
        (SELECT COUNT(*) FROM bookmarks WHERE confidence <= 0.45) AS low_confidence_bookmarks,
        (SELECT COUNT(*) FROM entities) AS entities,
        (SELECT COUNT(*) FROM mentions) AS mentions,
        (SELECT COUNT(*) FROM relationships) AS relationships,
        (SELECT COUNT(*) FROM relationships WHERE source_type = 'unsourced') AS unsourced_relationships,
        (SELECT COUNT(*) FROM relationships WHERE confidence <= 0.45) AS low_confidence_relationships
    `).get();
    const recent_bookmarks = searcher.db.prepare(`
      SELECT id, kind, title, source_type, confidence, tags, created_at
      FROM bookmarks ORDER BY created_at DESC LIMIT 10
    `).all();
    const recent_relationships = searcher.db.prepare(`
      SELECT r.id, fe.name AS from_name, r.rel_type, te.name AS to_name, r.source_type, r.confidence, r.created_at
      FROM relationships r
      JOIN entities fe ON fe.id = r.from_entity_id
      JOIN entities te ON te.id = r.to_entity_id
      ORDER BY r.created_at DESC LIMIT 10
    `).all();
    sendJson(res, 200, { summary, recent_bookmarks, recent_relationships });
  } catch (e) {
    sendJson(res, 500, { error: String(e && e.message || e) });
  }
}

function handleDeleteBookmark(url, res) {
  const id = parseIntOr(url.searchParams.get('id'), null);
  if (id == null) return sendJson(res, 400, { error: 'id required' });
  try {
    const tx = writerDb.transaction(() => {
      writerDb.prepare("DELETE FROM mentions WHERE source_type = 'bookmark' AND source_id = ?").run(id);
      const info = writerDb.prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
      return info.changes;
    });
    sendJson(res, 200, { deleted: tx(), id });
  } catch (e) {
    sendJson(res, 500, { error: String(e && e.message || e) });
  }
}

function handleDeleteRelationship(url, res) {
  const id = parseIntOr(url.searchParams.get('id'), null);
  if (id == null) return sendJson(res, 400, { error: 'id required' });
  try {
    const info = writerDb.prepare('DELETE FROM relationships WHERE id = ?').run(id);
    sendJson(res, 200, { deleted: info.changes, id });
  } catch (e) {
    sendJson(res, 500, { error: String(e && e.message || e) });
  }
}

function resolveNearestMessageSource(b) {
  const sessionKey = b.session_key || null;
  const ts = Number.isFinite(Number(b.ts)) ? Number(b.ts) : null;
  if (!sessionKey || !ts) {
    if (b.source_type === 'session') {
      try {
        const row = writerDb.prepare(`
          SELECT id, session_key, jsonl_path, line_no, ts
          FROM messages
          WHERE ts >= ?
          ORDER BY ts DESC, id DESC
          LIMIT 1
        `).get(Date.now() - 15 * 60 * 1000);
        return row || {};
      } catch {
        return {};
      }
    }
    return {};
  }
  try {
    const row = writerDb.prepare(`
      SELECT id, jsonl_path, line_no, ts
      FROM messages
      WHERE session_key = ?
      ORDER BY ABS(ts - ?) ASC
      LIMIT 1
    `).get(sessionKey, ts);
    if (!row) return {};
    // Only auto-link when reasonably close. This avoids falsely linking a
    // bookmark created long after a referenced conversation.
    if (Math.abs(Number(row.ts) - ts) > 15 * 60 * 1000) return {};
    return row;
  } catch {
    return {};
  }
}

function handleEntities(url, res) {
  const q = url.searchParams.get('q');
  const limit = parseIntOr(url.searchParams.get('limit'), 20);
  try {
    if (q) {
      const like = `%${q.toLowerCase()}%`;
      const rows = searcher.db.prepare(`
        SELECT * FROM entities
        WHERE lower(name) LIKE ? OR normalized LIKE ?
        ORDER BY mention_count DESC, last_seen DESC
        LIMIT ?
      `).all(like, like, limit);
      return sendJson(res, 200, rows);
    }
    const rows = searcher.db.prepare(`
      SELECT * FROM entities
      ORDER BY mention_count DESC, last_seen DESC
      LIMIT ?
    `).all(limit);
    sendJson(res, 200, rows);
  } catch (e) {
    sendJson(res, 500, { error: String(e && e.message || e) });
  }
}

function handleEntityMentions(url, res) {
  const id = url.searchParams.get('id') ? parseIntOr(url.searchParams.get('id'), null) : null;
  const q = url.searchParams.get('q');
  const limit = parseIntOr(url.searchParams.get('limit'), 20);
  try {
    let entity = null;
    if (id != null) entity = searcher.db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
    else if (q) {
      const nq = q.toLowerCase();
      entity = searcher.db.prepare(`
        SELECT e.*
        FROM entities e
        LEFT JOIN entity_aliases a ON a.entity_id = e.id
        WHERE lower(e.name) = ?
           OR e.normalized = ?
           OR e.normalized LIKE ?
           OR lower(a.alias) = ?
           OR a.normalized = ?
           OR a.normalized LIKE ?
        ORDER BY mention_count DESC LIMIT 1
      `).get(nq, nq, `%:${nq}`, nq, nq, `%:${nq}`);
    }
    if (!entity) return sendJson(res, 404, { error: 'entity not found' });
    const mentions = searcher.db.prepare(`
      SELECT mn.*, m.role, m.line_no, m.content
      FROM mentions mn
      LEFT JOIN messages m ON mn.source_type = 'message' AND mn.source_id = m.id
      WHERE mn.entity_id = ?
      ORDER BY mn.ts DESC
      LIMIT ?
    `).all(entity.id, limit).map((r) => ({ ...r, content: r.content ? r.content.slice(0, 1000) : null }));
    sendJson(res, 200, { entity, mentions });
  } catch (e) {
    sendJson(res, 500, { error: String(e && e.message || e) });
  }
}

function handleRelationships(url, res) {
  const q = url.searchParams.get('q');
  const limit = parseIntOr(url.searchParams.get('limit'), 50);
  try {
    const params = [];
    let where = '';
    if (q) {
      where = `WHERE lower(fe.name) LIKE ? OR lower(te.name) LIKE ? OR lower(r.rel_type) LIKE ?`;
      const like = `%${q.toLowerCase()}%`;
      params.push(like, like, like);
    }
    params.push(limit);
    const rows = searcher.db.prepare(`
      SELECT r.*, fe.type AS from_type, fe.name AS from_name, te.type AS to_type, te.name AS to_name
      FROM relationships r
      JOIN entities fe ON fe.id = r.from_entity_id
      JOIN entities te ON te.id = r.to_entity_id
      ${where}
      ORDER BY r.created_at DESC
      LIMIT ?
    `).all(...params);
    sendJson(res, 200, rows);
  } catch (e) {
    sendJson(res, 500, { error: String(e && e.message || e) });
  }
}

function ensureNamedEntity({ type, name, ts }) {
  const entity = {
    type: String(type || 'concept').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 40),
    name: String(name || '').trim().slice(0, 240),
  };
  if (!entity.name || entity.name.length < 2) throw new Error('entity name too short');
  entity.normalized = `${entity.type}:${entity.name.toLowerCase().replace(/\s+/g, ' ')}`;
  const now = Date.now();
  entityStmts.insert.run({ ...entity, ts: ts || now, now });
  const row = entityStmts.find.get(entity.normalized);
  if (!row) throw new Error('failed to create entity');
  entityStmts.alias.run({ entity_id: row.id, alias: entity.name, normalized: entity.normalized, now });
  return { id: row.id, ...entity };
}

async function handleCreateRelationship(req, res) {
  try {
    const b = await readJsonBody(req);
    const from = b.from || { type: b.from_type, name: b.from_name };
    const to = b.to || { type: b.to_type, name: b.to_name };
    if (!from?.name || !to?.name || !b.rel_type) {
      return sendJson(res, 400, { error: 'from.name, to.name, and rel_type required' });
    }
    const relType = String(b.rel_type).trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
    if (!relType || relType.length < 2) return sendJson(res, 400, { error: 'invalid rel_type' });
    if (!ALLOWED_REL_TYPES.has(relType)) return sendJson(res, 400, { error: `rel_type not allowed: ${relType}`, allowed: [...ALLOWED_REL_TYPES].sort() });
    let confidence = Number.isFinite(Number(b.confidence)) ? Number(b.confidence) : 0.65;
    confidence = Math.max(0, Math.min(1, confidence));
    const nearest = resolveNearestMessageSource(b);
    const sourceType = b.source_type || (b.source_id || b.session_key || b.ts ? 'session' : 'unsourced');
    if (sourceType === 'unsourced') confidence = Math.min(confidence, 0.45);
    const ts = Number.isFinite(Number(b.ts)) ? Number(b.ts) : Date.now();
    const tx = writerDb.transaction(() => {
      const fe = ensureNamedEntity({ type: from.type || 'concept', name: from.name, ts });
      const te = ensureNamedEntity({ type: to.type || 'concept', name: to.name, ts });
      const info = writerDb.prepare(`
        INSERT OR IGNORE INTO relationships (from_entity_id, to_entity_id, rel_type, source_type, source_id, confidence, status, valid_from, valid_to, supersedes_id, created_at)
        VALUES (@from_entity_id, @to_entity_id, @rel_type, @source_type, @source_id, @confidence, @status, @valid_from, @valid_to, @supersedes_id, @created_at)
      `).run({
        from_entity_id: fe.id,
        to_entity_id: te.id,
        rel_type: relType,
        source_type: sourceType,
        source_id: Number.isFinite(Number(b.source_id)) ? Number(b.source_id) : (Number.isFinite(Number(nearest.id)) ? Number(nearest.id) : null),
        confidence,
        status: b.status || 'active',
        valid_from: Number.isFinite(Number(b.valid_from)) ? Number(b.valid_from) : null,
        valid_to: Number.isFinite(Number(b.valid_to)) ? Number(b.valid_to) : null,
        supersedes_id: Number.isFinite(Number(b.supersedes_id)) ? Number(b.supersedes_id) : null,
        created_at: Date.now(),
      });
      if (info.changes > 0 && Number.isFinite(Number(b.supersedes_id))) {
        writerDb.prepare("UPDATE relationships SET status='superseded', superseded_by_id=? WHERE id=?").run(info.lastInsertRowid, Number(b.supersedes_id));
      }
      const rel = info.lastInsertRowid ? writerDb.prepare(`
        SELECT r.*, fe.type AS from_type, fe.name AS from_name, te.type AS to_type, te.name AS to_name
        FROM relationships r
        JOIN entities fe ON fe.id = r.from_entity_id
        JOIN entities te ON te.id = r.to_entity_id
        WHERE r.id = ?
      `).get(info.lastInsertRowid) : writerDb.prepare(`
        SELECT r.*, fe.type AS from_type, fe.name AS from_name, te.type AS to_type, te.name AS to_name
        FROM relationships r
        JOIN entities fe ON fe.id = r.from_entity_id
        JOIN entities te ON te.id = r.to_entity_id
        WHERE r.from_entity_id = ? AND r.to_entity_id = ? AND r.rel_type = ?
        ORDER BY r.id DESC LIMIT 1
      `).get(fe.id, te.id, relType);
      return { duplicate: info.changes === 0, relationship: rel };
    });
    sendJson(res, 201, tx());
  } catch (e) {
    sendJson(res, 400, { error: String(e && e.message || e) });
  }
}

function handlePatchStatus(table, url, res) {
  const id = parseIntOr(url.searchParams.get('id'), null);
  const status = url.searchParams.get('status') || 'archived';
  if (id == null) return sendJson(res, 400, { error: 'id required' });
  if (!['active','archived','superseded'].includes(status)) return sendJson(res, 400, { error: 'invalid status' });
  try {
    const info = writerDb.prepare(`UPDATE ${table} SET status = ? WHERE id = ?`).run(status, id);
    sendJson(res, 200, { updated: info.changes, id, status });
  } catch (e) { sendJson(res, 500, { error: String(e && e.message || e) }); }
}

function handleContext(url, res) {
  const q = url.searchParams.get('q');
  if (!q) return sendJson(res, 400, { error: 'missing q' });
  try {
    const body = buildContext(searcher, q, {
      limit: parseIntOr(url.searchParams.get('limit'), 5),
      minConfidence: url.searchParams.get('min_confidence') ? parseIntOr(url.searchParams.get('min_confidence'), 0.42) : 0.42,
    });
    sendJson(res, 200, body);
  } catch (e) {
    sendJson(res, 500, { error: String(e && e.message || e) });
  }
}

async function handleCreateBookmark(req, res) {
  try {
    const b = await readJsonBody(req);
    if (!b.title || !b.summary) return sendJson(res, 400, { error: 'title and summary required' });
    const allowedKinds = new Set(['note', 'decision', 'preference', 'fact', 'lesson', 'incident', 'rule', 'architecture', 'bug', 'workflow']);
    const kind = String(b.kind || 'note').toLowerCase();
    if (!allowedKinds.has(kind)) return sendJson(res, 400, { error: `invalid kind: ${kind}` });
    if (String(b.summary).trim().length < 20) return sendJson(res, 400, { error: 'summary too short; promote durable context, not a tiny note' });
    const sourceType = b.source_type || (b.session_key || b.ts || b.line_no || b.source_message_id ? 'session' : 'unsourced');
    let confidence = Number.isFinite(Number(b.confidence)) ? Number(b.confidence) : 0.7;
    confidence = Math.max(0, Math.min(1, confidence));
    if (sourceType === 'unsourced') confidence = Math.min(confidence, 0.45);
    const title = String(b.title).trim();
    const existing = writerDb.prepare(`
      SELECT * FROM bookmarks
      WHERE kind = ? AND lower(title) = lower(?)
      ORDER BY confidence DESC, created_at DESC
      LIMIT 1
    `).get(kind, title);
    if (existing && !b.force) {
      return sendJson(res, 200, { duplicate: true, bookmark: existing, note: 'existing bookmark with same kind/title; pass force=true to create another' });
    }
    const nearest = resolveNearestMessageSource(b);
    const row = {
      kind,
      title,
      summary: String(b.summary),
      session_key: b.session_key || nearest.session_key || null,
      ts: Number.isFinite(Number(b.ts)) ? Number(b.ts) : (Number.isFinite(Number(nearest.ts)) ? Number(nearest.ts) : null),
      jsonl_path: b.jsonl_path || nearest.jsonl_path || null,
      line_no: Number.isFinite(Number(b.line_no)) ? Number(b.line_no) : (Number.isFinite(Number(nearest.line_no)) ? Number(nearest.line_no) : null),
      source_type: sourceType,
      source_message_id: Number.isFinite(Number(b.source_message_id)) ? Number(b.source_message_id) : (Number.isFinite(Number(nearest.id)) ? Number(nearest.id) : null),
      confidence,
      promoted_by: b.promoted_by || 'agent',
      status: b.status || 'active',
      valid_from: Number.isFinite(Number(b.valid_from)) ? Number(b.valid_from) : null,
      valid_to: Number.isFinite(Number(b.valid_to)) ? Number(b.valid_to) : null,
      supersedes_id: Number.isFinite(Number(b.supersedes_id)) ? Number(b.supersedes_id) : null,
      tags: Array.isArray(b.tags) ? b.tags.join(',') : (b.tags || null),
      created_at: Date.now(),
    };
    const info = writerDb.prepare(`
      INSERT INTO bookmarks (kind, title, summary, session_key, ts, jsonl_path, line_no, source_type, source_message_id, confidence, promoted_by, status, valid_from, valid_to, supersedes_id, tags, created_at)
      VALUES (@kind, @title, @summary, @session_key, @ts, @jsonl_path, @line_no, @source_type, @source_message_id, @confidence, @promoted_by, @status, @valid_from, @valid_to, @supersedes_id, @tags, @created_at)
    `).run(row);
    if (Number.isFinite(Number(row.supersedes_id))) {
      writerDb.prepare("UPDATE bookmarks SET status='superseded', superseded_by_id=? WHERE id=?").run(info.lastInsertRowid, Number(row.supersedes_id));
    }
    indexEntitiesForSource(writerDb, entityStmts, {
      source_type: 'bookmark',
      source_id: Number(info.lastInsertRowid),
      session_key: row.session_key,
      ts: row.ts || row.created_at,
      field: 'summary',
      text: `${row.title}\n${row.summary}\n${row.tags || ''}`,
    });
    sendJson(res, 201, { id: info.lastInsertRowid, ...row });
  } catch (e) {
    sendJson(res, 400, { error: String(e && e.message || e) });
  }
}

const server = http.createServer((req, res) => {
  if (!isLocal(req)) {
    res.writeHead(403); return res.end('forbidden');
  }
  // CORS: allow only localhost origins
  const origin = req.headers.origin || '';
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  let url;
  try { url = new URL(req.url, `http://${HOST}:${PORT}`); }
  catch { return sendJson(res, 400, { error: 'bad url' }); }

  if (req.method === 'POST' && url.pathname === '/bookmarks') return handleCreateBookmark(req, res);
  if (req.method === 'POST' && url.pathname === '/relationships') return handleCreateRelationship(req, res);
  if (req.method === 'PATCH' && url.pathname === '/bookmarks') return handlePatchStatus('bookmarks', url, res);
  if (req.method === 'PATCH' && url.pathname === '/relationships') return handlePatchStatus('relationships', url, res);
  if (req.method === 'DELETE' && url.pathname === '/bookmarks') return handleDeleteBookmark(url, res);
  if (req.method === 'DELETE' && url.pathname === '/relationships') return handleDeleteRelationship(url, res);
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });

  switch (url.pathname) {
    case '/':
    case '/memory':
    case '/memory/':
    case '/index.html': {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(UI_HTML),
        'cache-control': 'no-store',
      });
      return res.end(UI_HTML);
    }
    case '/health':  return handleHealth(req, res);
    case '/stats':   return handleStats(url, res);
    case '/search':  return handleSearch(url, res);
    case '/recall':  return handleRecall(url, res);
    case '/bookmarks': return handleBookmarks(url, res);
    case '/audit': return handleAudit(url, res);
    case '/entities': return handleEntities(url, res);
    case '/entity/mentions': return handleEntityMentions(url, res);
    case '/relationships': return handleRelationships(url, res);
    case '/context': return handleContext(url, res);
    default:         return sendJson(res, 404, { error: 'not found' });
  }
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[session-memory] FATAL: port ${PORT} already in use on ${HOST}. Refusing to pick a different port.`);
    process.exit(2);
  }
  console.error('[session-memory] server error:', err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  logJson({ event: 'listening', host: HOST, port: PORT });
});

function shutdown(sig) {
  logJson({ event: 'service_shutdown', signal: sig });
  server.close(() => {
    try { searcher.close(); } catch {}
    try { writerDb.close(); } catch {}
    // watcher installs its own SIGTERM/SIGINT handlers and will call process.exit(0)
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
