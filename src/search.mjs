// session-memory search
import Database from 'better-sqlite3';

const STOPWORDS = new Set([
  'a','an','and','are','as','at','be','but','by','can','could','did','do','does','for','from','had','has','have','how','i','if','in','is','it','me','my','of','on','or','our','should','so','that','the','this','to','was','we','were','what','when','where','which','who','why','will','with','without','you','your'
]);

const EXPANSIONS = new Map([
  ['downgrade', ['rollback', 'revert', '2026.4.23', 'legacy', 'LCM', 'timeout']],
  ['rollback', ['downgrade', 'revert', '2026.4.23']],
  ['openclaw', ['OCPlatform', 'gateway', '2026.4.23', '2026.5.18']],
  ['lcm', ['lossless-claw', 'compaction', 'contextEngine', 'legacy']],
  ['memory', ['session-memory', 'agentmemory', 'recall', 'FTS5']],
  ['session', ['session-memory', 'sessions', 'jsonl']],
  ['search', ['recall', 'FTS5', 'session_search', 'session_recall']],
  ['missing', ['unindexed', 'gap', 'diff', 'orphan']],
  ['sessions', ['jsonl', 'session', 'Codex', 'ACP']],
  ['timeout', ['408', 'FailoverError', 'unknown error']],
  ['proxy', ['gateway', 'tunnel', 'socks']],
  ['merge', ['self-merge', 'merged', 'merging']],
  ['pr', ['PRs', 'pull request', 'pull requests']],
  ['approval', ['approve', 'approved', 'explicit approval']],
]);

function escapeFts(s) { return String(s).replace(/"/g, '').trim(); }

function plainTerms(query) {
  return query
    .trim()
    .split(/\s+/)
    .map(t => t.replace(/^\W+|\W+$/g, ''))
    .filter(Boolean)
    .filter(t => !STOPWORDS.has(t.toLowerCase()));
}

function buildPlainMatch(query) {
  const terms = plainTerms(query);
  if (!terms.length) return `"${escapeFts(query)}"`;
  return terms.map((term) => {
    const lower = term.toLowerCase();
    const variants = [term, ...(EXPANSIONS.get(lower) || [])]
      .map(escapeFts)
      .filter(Boolean)
      .slice(0, 7);
    if (variants.length === 1) return `"${variants[0]}"`;
    return '(' + variants.map(v => `"${v}"`).join(' OR ') + ')';
  }).join(' AND ');
}

function buildRelaxedMatch(query) {
  const terms = plainTerms(query);
  if (!terms.length) return `"${escapeFts(query)}"`;
  const variants = [];
  for (const term of terms) {
    const lower = term.toLowerCase();
    variants.push(term, ...(EXPANSIONS.get(lower) || []));
  }
  return [...new Set(variants.map(escapeFts).filter(Boolean))]
    .slice(0, 24)
    .map(v => `"${v}"`)
    .join(' OR ');
}

function rerank(rows, query) {
  const q = query.toLowerCase();
  const terms = plainTerms(query).map(t => t.toLowerCase());
  return rows.map((row) => {
    const text = `${row.role || ''} ${row.snippet || ''} ${row._content || ''}`.toLowerCase();
    // BM25 is still the base signal, but compress it so conversational quality
    // boosts can beat noisy tool output that happens to contain many terms.
    let adjusted = row.score * 0.35;
    const coverage = terms.length ? terms.filter(t => text.includes(t)).length / terms.length : 0;
    adjusted -= coverage * 2.0;
    const numericTerms = terms.filter(t => /\d/.test(t));
    if (numericTerms.length && numericTerms.every(t => text.includes(t))) adjusted -= 8.0;
    if (row.role === 'assistant') adjusted -= 2.0;
    if (row.role === 'user') adjusted -= 0.8;
    if (row.role === 'toolResult' && /\bwhy\b|\breason\b|\bdecision\b/.test(q)) adjusted += 10.0;
    if (row.role === 'toolResult' && /const |function |import |node scripts\/eval|raw_score|score=|EXPANSIONS|buildPlainMatch|eval report|session-memory-golden|context-golden|## failures|\bq\d{3}\b|\bctx\d{3}\b|"query"\s*:|"id"\s*:\s*"(?:q|ctx)\d+/i.test(text)) adjusted += 30.0;
    if (/\bwhy\b|\breason\b/.test(q) && /because|reason|issue|caused|root cause|decided|decision|rollback|downgrade/.test(text)) adjusted -= 2.0;
    if (/\bor\s+"|\band\s+"|fts|match|snippet\(/.test(text)) adjusted += 20.0;
    const { _content, ...publicRow } = row;
    return { ...publicRow, score: adjusted, raw_score: row.score };
  }).sort((a, b) => a.score - b.score);
}

function groupRows(rows, { windowMs = 15 * 60 * 1000, maxContext = 5 } = {}) {
  const groups = [];
  for (const row of rows) {
    const ts = row.ts || 0;
    let g = groups.find(x => x.session_key === row.session_key && ts >= x.start_ts - windowMs && ts <= x.end_ts + windowMs);
    if (!g) {
      g = {
        session_key: row.session_key,
        start_ts: ts,
        end_ts: ts,
        hit_count: 0,
        best_hit: row,
        hits: [],
      };
      groups.push(g);
    }
    g.hit_count++;
    g.start_ts = Math.min(g.start_ts, ts);
    g.end_ts = Math.max(g.end_ts, ts);
    if (row.score < g.best_hit.score) g.best_hit = row;
    if (g.hits.length < maxContext) g.hits.push(row);
  }
  return groups
    .sort((a, b) => a.best_hit.score - b.best_hit.score)
    .map((g) => ({
      ...g,
      duration_ms: Math.max(0, g.end_ts - g.start_ts),
      recall: {
        session_key: g.best_hit.session_key,
        around_ts: g.best_hit.ts,
        window: 8,
      },
    }));
}

export class Searcher {
  constructor(dbPath, opts = {}) {
    this.db = new Database(dbPath, { readonly: opts.readonly ?? true, fileMustExist: true });
    this.db.pragma('journal_mode = WAL');
  }

  close() { this.db.close(); }

  /**
   * Full-text search with BM25 ranking + snippets.
   * @param {string} query - FTS5 MATCH expression (raw words are AND-ed)
   * @param {object} opts
   *   limit         number (default 20)
   *   trigram       boolean (default false) - use trigram index instead
   *   session_key   string filter
   *   channel       string filter
   *   since         ms epoch lower bound
   *   until         ms epoch upper bound
   *   role          string filter
   */
  search(query, opts = {}) {
    const limit = opts.limit ?? 20;
    const ftsTable = opts.trigram ? 'messages_fts_trigram' : 'messages_fts';

    // Sanitize for FTS5: if user gives plain words, remove weak stopwords and
    // expand a few high-signal local terms. If they pass operators, trust them.
    // If they pass operators (OR, NEAR, ", *, etc.) trust them.
    let match = query;
    const isPlainQuery = !/["*:()]|\bOR\b|\bNEAR\b|\bAND\b|\bNOT\b/.test(query);
    if (isPlainQuery) {
      match = buildPlainMatch(query);
    }

    const conds = [`${ftsTable} MATCH ?`];
    const params = [match];
    if (!opts.include_checkpoints) {
      conds.push("m.jsonl_path NOT LIKE '%.checkpoint.%'");
      conds.push("m.jsonl_path NOT LIKE '%/__sm_watcher_test_%'");
      conds.push("m.session_key NOT LIKE '%.checkpoint.%'");
      conds.push("m.session_key NOT LIKE '__sm_watcher_test_%'");
    }
    if (opts.session_key) { conds.push('m.session_key = ?'); params.push(opts.session_key); }
    if (opts.channel)     { conds.push('s.channel = ?');     params.push(opts.channel); }
    if (opts.role)        { conds.push('m.role = ?');        params.push(opts.role); }
    if (opts.since)       { conds.push('m.ts >= ?');         params.push(opts.since); }
    if (opts.until)       { conds.push('m.ts <= ?');         params.push(opts.until); }

    const fetchLimit = Math.min(Math.max(limit * 5, limit), 100);
    const sql = `
      SELECT
        m.session_key AS session_key,
        m.ts          AS ts,
        m.jsonl_path  AS jsonl_path,
        m.line_no     AS line_no,
        m.role        AS role,
        m.content     AS _content,
        snippet(${ftsTable}, 0, '[', ']', '…', 12) AS snippet,
        bm25(${ftsTable}) AS score
      FROM ${ftsTable}
      JOIN messages   AS m ON m.id = ${ftsTable}.rowid
      LEFT JOIN sessions AS s ON s.session_key = m.session_key
      WHERE ${conds.join(' AND ')}
      ORDER BY score ASC
      LIMIT ?
    `;
    params.push(fetchLimit);

    const stmt = this.db.prepare(sql);
    let rows = stmt.all(...params);
    if (!rows.length && isPlainQuery) {
      const retryParams = [...params];
      retryParams[0] = buildRelaxedMatch(query);
      rows = stmt.all(...retryParams);
    }
    return rerank(rows, query).slice(0, limit);
  }

  searchGrouped(query, opts = {}) {
    const rowLimit = Math.max(opts.rowLimit || opts.limit * 6 || 60, opts.limit || 10);
    const rows = this.search(query, { ...opts, limit: rowLimit });
    return groupRows(rows, {
      windowMs: opts.windowMs ?? 15 * 60 * 1000,
      maxContext: opts.maxContext ?? 5,
    }).slice(0, opts.limit ?? 10);
  }

  /** Fetch +/- window neighbors around a hit. */
  recall(session_key, around_ts, window = 10) {
    const before = this.db.prepare(`
      SELECT * FROM messages
       WHERE session_key = ? AND ts <= ?
       ORDER BY ts DESC LIMIT ?
    `).all(session_key, around_ts, window).reverse();
    const after = this.db.prepare(`
      SELECT * FROM messages
       WHERE session_key = ? AND ts > ?
       ORDER BY ts ASC LIMIT ?
    `).all(session_key, around_ts, window);
    return [...before, ...after];
  }

  searchBookmarks(query, opts = {}) {
    const limit = opts.limit ?? 20;
    let match = query;
    const isPlainQuery = !/["*:()]|\bOR\b|\bNEAR\b|\bAND\b|\bNOT\b/.test(query);
    if (isPlainQuery) {
      match = buildPlainMatch(query);
    }
    const stmt = this.db.prepare(`
      SELECT
        b.*,
        snippet(bookmarks_fts, 1, '[', ']', '…', 18) AS snippet,
        bm25(bookmarks_fts) AS score
      FROM bookmarks_fts
      JOIN bookmarks AS b ON b.id = bookmarks_fts.rowid
      WHERE bookmarks_fts MATCH ?
        AND IFNULL(b.status, 'active') = 'active'
        AND (b.valid_from IS NULL OR b.valid_from <= unixepoch() * 1000)
        AND (b.valid_to IS NULL OR b.valid_to > unixepoch() * 1000)
      ORDER BY score ASC
      LIMIT ?
    `);
    let rows = stmt.all(match, limit);
    if (!rows.length && isPlainQuery) rows = stmt.all(buildRelaxedMatch(query), limit);
    return rows;
  }

  listBookmarks(opts = {}) {
    const limit = opts.limit ?? 50;
    return this.db.prepare(`
      SELECT * FROM bookmarks
      WHERE IFNULL(status, 'active') = 'active'
      ORDER BY COALESCE(ts, created_at) DESC, id DESC
      LIMIT ?
    `).all(limit);
  }
}
