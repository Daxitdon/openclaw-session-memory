// Gated context builder for automatic prompt injection.
// Conservative by design: returns nothing unless there is specific, high-signal context.

const GENERIC_TERMS = new Set([
  'what','why','how','when','where','who','should','could','would','can','do','does','did','is','are','was','were','the','a','an','to','for','of','in','on','and','or','but','with','this','that','it','we','you','our','my','your','use','using','memory','search','thing','issue','problem','work','working','next','continue','ok','yes','no','random','unrelated','lunch','weather','tomorrow','meme','make','create','hello','about','product','idea','brainstorm','eat','today','tell','joke'
]);

function terms(q) {
  return String(q || '')
    .toLowerCase()
    .split(/[^a-z0-9_.:/-]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 3 && !GENERIC_TERMS.has(s));
}

function clean(s, n = 500) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);
}

function coverage(text, queryTerms) {
  const t = String(text || '').toLowerCase();
  return queryTerms.length ? queryTerms.filter(q => t.includes(q)).length / queryTerms.length : 0;
}

function uniqueBy(rows, keyFn) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = keyFn(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function confidenceForSearchGroup(g, queryTerms) {
  const h = g.best_hit || {};
  const text = `${h.snippet || ''} ${h.role || ''}`.toLowerCase();
  if (/\bctx\d{3}\b|context-golden|"shouldinject"|"query"\s*:/.test(text)) return 0;
  const coverage = queryTerms.length ? queryTerms.filter(t => text.includes(t)).length / queryTerms.length : 0;
  const hasSpecificTerm = queryTerms.some(t => /\d|[_./:-]|[a-z]+[0-9]+|[0-9]+[a-z]+/.test(t) || t.length >= 9);
  // Automatic context injection must be stricter than manual search. A single
  // weak word like "random" should not pull old context into a casual query.
  if (coverage < 0.4 && !hasSpecificTerm) return 0;
  let conf = 0;
  if (coverage >= 0.67) conf += 0.45;
  else if (coverage >= 0.4) conf += 0.25;
  if (g.hit_count >= 2) conf += 0.2;
  if (h.role === 'assistant' || h.role === 'user') conf += 0.15;
  if (Number.isFinite(h.score) && h.score < -5) conf += 0.15;
  if (h.role === 'toolResult') conf -= 0.1;
  return Math.max(0, Math.min(1, conf));
}

export function buildContext(searcher, query, opts = {}) {
  const limit = opts.limit ?? 5;
  const minConfidence = opts.minConfidence ?? 0.42;
  const qTerms = terms(query);

  // Avoid injecting context on tiny/generic replies like “yes”, “continue”, “ok”.
  if (qTerms.length < 2 && !/[A-Z][A-Za-z0-9_-]{3,}|\d{3,}|\//.test(String(query))) {
    return { query, injected: false, reason: 'query_too_generic', items: [] };
  }

  const items = [];

  const bookmarks = searcher.searchBookmarks(query, { limit: 4 })
    .map(b => {
      const cov = coverage(`${b.title} ${b.summary} ${b.tags || ''}`, qTerms);
      let conf = Math.max(0.45, Number(b.confidence || 0.6)) + Math.min(0.2, cov * 0.25);
      if (cov < 0.25 && qTerms.length >= 3) conf -= 0.25;
      if (['decision','rule','preference','architecture','lesson','fact','workflow'].includes(b.kind)) conf += 0.05;
      return {
        kind: 'bookmark',
        confidence: Math.max(0, Math.min(0.98, conf)),
        title: b.title,
        text: clean(b.summary, 550),
        source: b.session_key ? `${b.session_key}@${b.ts || b.created_at || ''}` : `bookmark:${b.id}`,
      };
    })
    .filter(x => x.confidence >= minConfidence);
  items.push(...bookmarks);

  const relRows = relationshipContext(searcher, qTerms, { limit: 4 })
    .map(r => ({
      kind: 'relationship',
      confidence: Math.min(0.98, Math.max(0.45, Number(r.confidence || 0.6)) + 0.18),
      title: `${r.from_name} ${r.rel_type} ${r.to_name}`,
      text: clean(`${r.from_type}:${r.from_name} --${r.rel_type}--> ${r.to_type}:${r.to_name}`, 260),
      source: `relationship:${r.id}`,
    }))
    .filter(x => x.confidence >= minConfidence);
  items.push(...relRows);

  const entityRows = entityMentionContext(searcher, qTerms, { limit: 3 })
    .map(e => ({
      kind: 'entity',
      confidence: 0.5,
      title: `${e.type}:${e.name}`,
      text: clean(`${e.name} has ${e.mention_count} indexed mentions. Recent source: ${e.session_key || 'n/a'}:${e.ts || ''}`, 260),
      source: `entity:${e.id}`,
    }))
    .filter(x => x.confidence >= minConfidence);
  items.push(...entityRows);

  const groups = searcher.searchGrouped(query, { limit: 6, maxContext: 2 })
    .map(g => {
      const h = g.best_hit || {};
      return {
        kind: 'session',
        confidence: confidenceForSearchGroup(g, qTerms),
        title: `${h.role || 'message'} hit (${g.hit_count} mentions in episode)`,
        text: clean(h.snippet || h.content || '', 420),
        source: `${h.session_key}:${h.ts}:L${h.line_no}`,
        recall: g.recall,
      };
    })
    .filter(x => x.confidence >= minConfidence);
  items.push(...groups);

  const picked = uniqueBy(items.sort((a, b) => b.confidence - a.confidence), x => `${x.kind}:${x.source}`)
    .slice(0, limit);

  if (!picked.length) return { query, injected: false, reason: 'low_confidence', items: [] };

  const block = picked.map((x, i) => {
    const pct = Math.round(x.confidence * 100);
    return `${i + 1}. [${x.kind}, ${pct}%] ${x.title}\n   ${x.text}\n   source: ${x.source}`;
  }).join('\n');

  return {
    query,
    injected: true,
    item_count: picked.length,
    items: picked,
    prependContext: [
      'Relevant memory from session-memory (source-linked; use as background, not authority):',
      block,
      'Prefer current user instructions and direct file/tool evidence over this context.',
    ].join('\n'),
  };
}

function relationshipContext(searcher, qTerms, { limit = 4 } = {}) {
  if (!qTerms.length) return [];
  const likeTerms = qTerms.filter(t => t.length >= 4).slice(0, 8);
  if (!likeTerms.length) return [];
  const clauses = [];
  const params = [];
  for (const t of likeTerms) {
    const like = `%${t}%`;
    clauses.push('(lower(fe.name) LIKE ? OR lower(te.name) LIKE ? OR lower(r.rel_type) LIKE ?)');
    params.push(like, like, like);
  }
  params.push(limit * 4);
  const rows = searcher.db.prepare(`
    SELECT r.*, fe.type AS from_type, fe.name AS from_name, te.type AS to_type, te.name AS to_name
    FROM relationships r
    JOIN entities fe ON fe.id = r.from_entity_id
    JOIN entities te ON te.id = r.to_entity_id
    WHERE (${clauses.join(' OR ')})
      AND IFNULL(r.status, 'active') = 'active'
      AND (r.valid_from IS NULL OR r.valid_from <= unixepoch() * 1000)
      AND (r.valid_to IS NULL OR r.valid_to > unixepoch() * 1000)
    ORDER BY r.confidence DESC, r.created_at DESC
    LIMIT ?
  `).all(...params);
  return rows
    .map(r => ({ ...r, _cov: coverage(`${r.from_name} ${r.rel_type} ${r.to_name}`, qTerms) }))
    .filter(r => r._cov >= 0.25 || qTerms.some(t => `${r.from_name} ${r.to_name}`.toLowerCase().includes(t)))
    .sort((a, b) => (b._cov - a._cov) || (b.confidence - a.confidence))
    .slice(0, limit);
}

function entityMentionContext(searcher, qTerms, { limit = 3 } = {}) {
  const strong = qTerms.filter(t => t.length >= 5 || /\d|[_./:-]/.test(t)).slice(0, 6);
  if (!strong.length) return [];
  const clauses = [];
  const params = [];
  for (const t of strong) {
    const like = `%${t}%`;
    clauses.push('(lower(e.name) LIKE ? OR e.normalized LIKE ?)');
    params.push(like, like);
  }
  params.push(limit);
  return searcher.db.prepare(`
    SELECT e.*, mn.session_key, mn.ts
    FROM entities e
    LEFT JOIN mentions mn ON mn.entity_id = e.id
    WHERE ${clauses.join(' OR ')}
    GROUP BY e.id
    ORDER BY e.mention_count DESC, e.last_seen DESC
    LIMIT ?
  `).all(...params);
}
