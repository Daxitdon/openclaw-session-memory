#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || (process.env.HOME + '/.openclaw/state/session-memory.db');
const REPORT_DIR = process.env.REPORT_DIR || `${process.env.HOME}/.openclaw/reports/session-memory-diagnose`;
fs.mkdirSync(REPORT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

function one(sql) { return db.prepare(sql).get(); }
function all(sql) { return db.prepare(sql).all(); }
function scalar(sql) { return Object.values(one(sql))[0]; }

const checks = [];
function check(name, severity, sql, expect = 0) {
  const value = scalar(sql);
  const ok = value === expect;
  checks.push({ name, severity, ok, value, expect });
}

const integrity = one('PRAGMA integrity_check');
checks.push({ name: 'sqlite_integrity_check', severity: 'critical', ok: integrity.integrity_check === 'ok', value: integrity.integrity_check, expect: 'ok' });
check('orphan_message_fts', 'critical', `SELECT COUNT(*) FROM messages_fts f LEFT JOIN messages m ON m.id = f.rowid WHERE m.id IS NULL`);
check('missing_message_fts', 'critical', `SELECT COUNT(*) FROM messages m LEFT JOIN messages_fts f ON f.rowid = m.id WHERE f.rowid IS NULL`);
check('orphan_trigram_fts', 'warning', `SELECT COUNT(*) FROM messages_fts_trigram f LEFT JOIN messages m ON m.id = f.rowid WHERE m.id IS NULL`);
check('missing_trigram_fts', 'warning', `SELECT COUNT(*) FROM messages m LEFT JOIN messages_fts_trigram f ON f.rowid = m.id WHERE f.rowid IS NULL`);
check('orphan_bookmark_fts', 'critical', `SELECT COUNT(*) FROM bookmarks_fts f LEFT JOIN bookmarks b ON b.id = f.rowid WHERE b.id IS NULL`);
check('missing_bookmark_fts', 'critical', `SELECT COUNT(*) FROM bookmarks b LEFT JOIN bookmarks_fts f ON f.rowid = b.id WHERE f.rowid IS NULL`);
check('orphan_mentions_entity', 'warning', `SELECT COUNT(*) FROM mentions mn LEFT JOIN entities e ON e.id = mn.entity_id WHERE e.id IS NULL`);
check('orphan_mentions_message_source', 'warning', `SELECT COUNT(*) FROM mentions mn LEFT JOIN messages m ON mn.source_type='message' AND m.id = mn.source_id WHERE mn.source_type='message' AND m.id IS NULL`);
check('orphan_mentions_bookmark_source', 'warning', `SELECT COUNT(*) FROM mentions mn LEFT JOIN bookmarks b ON mn.source_type='bookmark' AND b.id = mn.source_id WHERE mn.source_type='bookmark' AND b.id IS NULL`);
check('orphan_relationship_from', 'critical', `SELECT COUNT(*) FROM relationships r LEFT JOIN entities e ON e.id = r.from_entity_id WHERE e.id IS NULL`);
check('orphan_relationship_to', 'critical', `SELECT COUNT(*) FROM relationships r LEFT JOIN entities e ON e.id = r.to_entity_id WHERE e.id IS NULL`);
check('duplicate_bookmark_kind_title', 'warning', `SELECT COUNT(*) FROM (SELECT kind, lower(title), COUNT(*) c FROM bookmarks GROUP BY kind, lower(title) HAVING c > 1)`);

const counts = one(`
  SELECT
    (SELECT COUNT(*) FROM messages) AS messages,
    (SELECT COUNT(*) FROM sessions) AS sessions,
    (SELECT COUNT(*) FROM bookmarks) AS bookmarks,
    (SELECT COUNT(*) FROM entities) AS entities,
    (SELECT COUNT(*) FROM mentions) AS mentions,
    (SELECT COUNT(*) FROM relationships) AS relationships,
    (SELECT COUNT(*) FROM bookmarks WHERE source_type='unsourced') AS unsourced_bookmarks,
    (SELECT COUNT(*) FROM bookmarks WHERE confidence <= 0.45) AS low_confidence_bookmarks,
    (SELECT COUNT(*) FROM relationships WHERE source_type='unsourced') AS unsourced_relationships,
    (SELECT COUNT(*) FROM relationships WHERE confidence <= 0.45) AS low_confidence_relationships
`);
const lowConfidence = all(`SELECT id, kind, title, source_type, confidence FROM bookmarks WHERE confidence <= 0.45 ORDER BY id LIMIT 50`);
const unsourcedRels = all(`
  SELECT r.id, fe.name AS from_name, r.rel_type, te.name AS to_name, r.confidence
  FROM relationships r
  JOIN entities fe ON fe.id = r.from_entity_id
  JOIN entities te ON te.id = r.to_entity_id
  WHERE r.source_type='unsourced' OR r.confidence <= 0.45
  ORDER BY r.id LIMIT 50
`);

db.close();
const failed = checks.filter(c => !c.ok);
const summary = {
  ok: failed.filter(c => c.severity === 'critical').length === 0,
  warning_count: failed.filter(c => c.severity !== 'critical').length,
  critical_count: failed.filter(c => c.severity === 'critical').length,
};
const report = { generated_at: new Date().toISOString(), db_path: DB_PATH, summary, counts, checks, lowConfidence, unsourcedRels };
const jsonPath = path.join(REPORT_DIR, `diagnose-${stamp}.json`);
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');
fs.writeFileSync(path.join(REPORT_DIR, 'latest.json'), JSON.stringify(report, null, 2) + '\n');
const md = [
  '# session-memory diagnose report', '',
  `Generated: ${report.generated_at}`,
  `OK: ${summary.ok} | critical: ${summary.critical_count} | warnings: ${summary.warning_count}`,
  '', '## Counts',
  ...Object.entries(counts).map(([k,v]) => `- ${k}: ${v}`),
  '', '## Checks',
  ...checks.map(c => `- ${c.ok ? '✅' : (c.severity === 'critical' ? '❌' : '⚠️')} ${c.name}: ${c.value} (expected ${c.expect})`),
  '', `JSON: ${jsonPath}`,
].join('\n');
const mdPath = jsonPath.replace(/\.json$/, '.md');
fs.writeFileSync(mdPath, md + '\n');
fs.writeFileSync(path.join(REPORT_DIR, 'latest.md'), md + '\n');
console.log(JSON.stringify({ ...summary, counts, report: mdPath }, null, 2));
if (summary.critical_count) process.exit(2);
