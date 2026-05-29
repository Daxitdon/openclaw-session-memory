// Deterministic graph-lite entity extraction for session-memory.
// Low-risk by design: creates source-linked mentions only, not durable claims.

export const KNOWN_ENTITIES = [
  // Seed hints for the deterministic extractor. Edit these for YOUR own
  // projects/tools/people. The examples below are intentionally generic.
  ['project', 'OCPlatform'],
  ['project', 'session-memory'],
  ['tool', 'agentmemory'],
  ['tool', 'Neo4j'],
  ['tool', 'sqlite-vec'],
  ['service', 'OpenClaw gateway'],
  ['person', 'Alice'],
  ['person', 'Bob'],
];

const RE = {
  file: /(?:^|[\s`"'(:])((?:\.{0,2}\/|~\/|\/root\/|[\w.-]+\/)[\w.\-\/]+\.[A-Za-z0-9]{1,8})(?=$|[\s`"'),:;])/g,
  absPath: /(?:^|[\s`"'(:])(\/root\/[\w.\-\/]+)(?=$|[\s`"'),:;])/g,
  domain: /\b((?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/[\w.\-/?=&%#]*)?\b/gi,
  ip: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  portUrl: /\b(?:https?:\/\/)?((?:127\.0\.0\.1|localhost|(?:\d{1,3}\.){3}\d{1,3}):\d{2,5})\b/g,
  githubRepo: /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/gi,
  serviceUnit: /\b([A-Za-z0-9_.@-]+\.service)\b/g,
  topic: /\btopic[:\s-]+(\d{2,})\b/gi,
};

const NON_DOMAIN_TLDS = new Set(['md','json','jsonl','mjs','js','ts','tsx','jsx','py','sh','txt','log','sql','html','css','png','jpg','jpeg','gif','webp','svg','tgz','zip','service']);

export function normalizeEntity(name, type = '') {
  return `${type}:${String(name).trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

function add(map, type, name, evidence, confidence = 1.0) {
  const clean = String(name || '').trim().replace(/^['"`]+|['"`.,;:)]+$/g, '');
  if (!clean || clean.length < 2 || clean.length > 240) return;
  if (type === 'domain') {
    const tld = clean.split('.').pop()?.toLowerCase();
    if (!tld || NON_DOMAIN_TLDS.has(tld)) return;
  }
  const normalized = normalizeEntity(clean, type);
  if (!map.has(normalized)) map.set(normalized, { type, name: clean, normalized, evidence, confidence });
}

function keywordRegex(name) {
  return new RegExp(`(^|\\W)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|\\W)`, 'i');
}

export function extractEntities(text) {
  const out = new Map();
  const s = String(text || '');
  if (!s) return [];

  for (const [type, name] of KNOWN_ENTITIES) {
    if (keywordRegex(name).test(s)) add(out, type, name, name, 0.95);
  }

  for (const m of s.matchAll(RE.file)) add(out, 'file', m[1], m[1], 0.98);
  for (const m of s.matchAll(RE.absPath)) add(out, 'path', m[1], m[1], 0.9);
  for (const m of s.matchAll(RE.domain)) add(out, 'domain', m[1], m[1], 0.95);
  for (const m of s.matchAll(RE.ip)) add(out, 'host', m[0], m[0], 0.95);
  for (const m of s.matchAll(RE.portUrl)) add(out, 'endpoint', m[1], m[1], 0.95);
  for (const m of s.matchAll(RE.githubRepo)) add(out, 'repo', m[1], m[1], 0.98);
  for (const m of s.matchAll(RE.serviceUnit)) add(out, 'service', m[1], m[1], 0.98);
  for (const m of s.matchAll(RE.topic)) add(out, 'topic', m[1], `topic ${m[1]}`, 0.85);

  return [...out.values()];
}

export function ensureEntityStatements(db) {
  return {
    find: db.prepare('SELECT id FROM entities WHERE normalized = ?'),
    insert: db.prepare(`
      INSERT INTO entities (type, name, normalized, first_seen, last_seen, mention_count, created_at, updated_at)
      VALUES (@type, @name, @normalized, @ts, @ts, 0, @now, @now)
      ON CONFLICT(normalized) DO UPDATE SET
        last_seen = MAX(COALESCE(last_seen, excluded.last_seen), excluded.last_seen),
        first_seen = MIN(COALESCE(first_seen, excluded.first_seen), excluded.first_seen),
        updated_at = excluded.updated_at
    `),
    alias: db.prepare(`
      INSERT OR IGNORE INTO entity_aliases (entity_id, alias, normalized, source, created_at)
      VALUES (@entity_id, @alias, @normalized, 'deterministic', @now)
    `),
    mention: db.prepare(`
      INSERT OR IGNORE INTO mentions (entity_id, source_type, source_id, session_key, ts, field, evidence, confidence, created_at)
      VALUES (@entity_id, @source_type, @source_id, @session_key, @ts, @field, @evidence, @confidence, @now)
    `),
    bump: db.prepare('UPDATE entities SET mention_count = mention_count + 1, updated_at = ? WHERE id = ?'),
  };
}

export function getEntity(db, q) {
  const normQ = String(q || '').trim().toLowerCase();
  return db.prepare(`
    SELECT e.*
    FROM entities e
    LEFT JOIN entity_aliases a ON a.entity_id = e.id
    WHERE e.normalized = ?
       OR lower(e.name) = ?
       OR a.normalized = ?
       OR lower(a.alias) = ?
    ORDER BY e.mention_count DESC
    LIMIT 1
  `).get(normQ, normQ, normQ, normQ);
}

export function indexEntitiesForSource(db, stmts, { source_type, source_id, session_key = null, ts = null, field = 'content', text }) {
  const ents = extractEntities(text);
  const now = Date.now();
  let added = 0;
  const tx = db.transaction(() => {
    for (const e of ents) {
      stmts.insert.run({ ...e, ts, now });
      const row = stmts.find.get(e.normalized);
      if (!row) continue;
      stmts.alias.run({ entity_id: row.id, alias: e.name, normalized: e.normalized, now });
      const info = stmts.mention.run({
        entity_id: row.id,
        source_type,
        source_id,
        session_key,
        ts,
        field,
        evidence: e.evidence,
        confidence: e.confidence,
        now,
      });
      if (info.changes > 0) {
        stmts.bump.run(now, row.id);
        added++;
      }
    }
  });
  tx();
  return { extracted: ents.length, added };
}
