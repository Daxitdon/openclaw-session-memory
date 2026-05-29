#!/usr/bin/env node
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { Indexer } from '../src/indexer.mjs';
import { ensureEntityStatements, indexEntitiesForSource } from '../src/entities.mjs';

const DB_PATH = process.env.DB_PATH || (process.env.HOME + '/.openclaw/state/session-memory.db');
const RESET = process.argv.includes('--reset');

function fmtMs(ms) { return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms/1000).toFixed(2)}s`; }

// Apply schema through Indexer because it already owns schema.sql loading.
const schema = new Indexer(DB_PATH);
schema.close();

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

if (RESET) {
  db.exec(`
    DELETE FROM relationships;
    DELETE FROM mentions;
    DELETE FROM entity_aliases;
    DELETE FROM entities;
  `);
}

const stmts = ensureEntityStatements(db);
const messages = db.prepare(`
  SELECT id, session_key, ts, content
  FROM messages
  WHERE content IS NOT NULL AND content != ''
  ORDER BY id
`).all();
const bookmarks = db.prepare(`
  SELECT id, session_key, ts, title, summary, tags, created_at
  FROM bookmarks
  ORDER BY id
`).all();

const t0 = process.hrtime.bigint();
let added = 0, extracted = 0, scanned = 0;
for (const m of messages) {
  const r = indexEntitiesForSource(db, stmts, {
    source_type: 'message',
    source_id: m.id,
    session_key: m.session_key,
    ts: m.ts,
    field: 'content',
    text: m.content,
  });
  extracted += r.extracted; added += r.added; scanned++;
  if (scanned % 2000 === 0) console.log(`[messages ${scanned}/${messages.length}] mentions +${added}`);
}
for (const b of bookmarks) {
  const r = indexEntitiesForSource(db, stmts, {
    source_type: 'bookmark',
    source_id: b.id,
    session_key: b.session_key,
    ts: b.ts || b.created_at,
    field: 'summary',
    text: `${b.title}\n${b.summary}\n${b.tags || ''}`,
  });
  extracted += r.extracted; added += r.added; scanned++;
}

const counts = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM entities) AS entities,
    (SELECT COUNT(*) FROM mentions) AS mentions,
    (SELECT COUNT(*) FROM entity_aliases) AS aliases
`).get();
const top = db.prepare(`
  SELECT type, name, mention_count
  FROM entities
  ORDER BY mention_count DESC, name ASC
  LIMIT 20
`).all();

db.close();
const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
console.log('---');
console.log(`DB: ${DB_PATH}`);
console.log(`Scanned sources: ${scanned}`);
console.log(`Extracted candidates: ${extracted}`);
console.log(`New mentions: ${added}`);
console.log(`Entities: ${counts.entities}`);
console.log(`Mentions: ${counts.mentions}`);
console.log(`Aliases: ${counts.aliases}`);
console.log(`Elapsed: ${fmtMs(elapsedMs)}`);
console.log('Top entities:');
for (const e of top) console.log(`- ${e.type}:${e.name} (${e.mention_count})`);
