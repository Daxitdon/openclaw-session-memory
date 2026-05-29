#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || (process.env.HOME + '/.openclaw/state/session-memory.db');
const OUT_DIR = process.env.OUT_DIR || `${process.env.HOME}/.openclaw/backups/session-memory`;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.mkdirSync(OUT_DIR, { recursive: true });

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
const backupPath = path.join(OUT_DIR, `session-memory-${stamp}.db`);
await db.backup(backupPath);

const curated = {
  exported_at: new Date().toISOString(),
  db_path: DB_PATH,
  bookmarks: db.prepare('SELECT * FROM bookmarks ORDER BY id').all(),
  relationships: db.prepare(`
    SELECT r.*, fe.type AS from_type, fe.name AS from_name, te.type AS to_type, te.name AS to_name
    FROM relationships r
    JOIN entities fe ON fe.id = r.from_entity_id
    JOIN entities te ON te.id = r.to_entity_id
    ORDER BY r.id
  `).all(),
};
const exportPath = path.join(OUT_DIR, `session-memory-curated-${stamp}.json`);
fs.writeFileSync(exportPath, JSON.stringify(curated, null, 2) + '\n');

const counts = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM messages) AS messages,
    (SELECT COUNT(*) FROM sessions) AS sessions,
    (SELECT COUNT(*) FROM bookmarks) AS bookmarks,
    (SELECT COUNT(*) FROM entities) AS entities,
    (SELECT COUNT(*) FROM mentions) AS mentions,
    (SELECT COUNT(*) FROM relationships) AS relationships
`).get();
db.close();
const stat = fs.statSync(backupPath);
console.log(JSON.stringify({ ok: true, backupPath, exportPath, bytes: stat.size, counts }, null, 2));
