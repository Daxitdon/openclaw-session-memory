#!/usr/bin/env node
// Backfill all OpenClaw/ACP session jsonls under ~/.openclaw/agents/ into session-memory.db
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Indexer } from '../src/indexer.mjs';

const HOME = os.homedir();
const SESSIONS_DIR = process.env.SESSIONS_ROOT || process.env.SESSIONS_DIR || path.join(HOME, '.openclaw/agents');
const DB_PATH = process.env.DB_PATH || path.join(HOME, '.openclaw/state/session-memory.db');

function collectJsonls(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      collectJsonls(p, out);
      continue;
    }
    if (!ent.isFile()) continue;
    if (!p.endsWith('.jsonl')) continue;
    if (!p.includes(`${path.sep}sessions${path.sep}`)) continue;
    if (p.includes('.checkpoint.')) continue;
    if (path.basename(p).startsWith('__sm_watcher_test_')) continue;
    if (p.endsWith('.trajectory.jsonl')) continue;
    if (p.endsWith('.trajectory-path.json')) continue;
    if (p.includes('.deleted.')) continue;
    out.push(p);
  }
  return out;
}

function fmtMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms/1000).toFixed(2)}s`;
}

function main() {
  if (!fs.existsSync(SESSIONS_DIR)) {
    console.error(`No sessions dir at ${SESSIONS_DIR}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const all = collectJsonls(SESSIONS_DIR).sort();
  console.log(`Found ${all.length} session jsonl files under ${SESSIONS_DIR}`);
  console.log(`DB: ${DB_PATH}`);

  const indexer = new Indexer(DB_PATH);
  const t0 = process.hrtime.bigint();
  let totalAdded = 0;
  let totalScanned = 0;
  let totalBytes = 0;
  let errors = 0;

  for (let i = 0; i < all.length; i++) {
    const file = all[i];
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    totalBytes += stat.size;
    try {
      const { added, scanned } = indexer.indexFile(file);
      totalAdded += added;
      totalScanned += scanned;
      if ((i + 1) % 25 === 0 || i === all.length - 1) {
        const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
        console.log(`[${i+1}/${all.length}] +${totalAdded} indexed / ${totalScanned} scanned (${fmtMs(elapsed)})`);
      }
    } catch (e) {
      errors++;
      console.warn(`ERR ${file}: ${e.message}`);
    }
  }

  // Optimize FTS
  console.log('Optimizing FTS...');
  indexer.db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('optimize')`);
  indexer.db.exec(`INSERT INTO messages_fts_trigram(messages_fts_trigram) VALUES('optimize')`);

  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const rowCount = indexer.db.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
  const sessCount = indexer.db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c;
  indexer.close();

  const dbStat = fs.statSync(DB_PATH);
  console.log('---');
  console.log(`Files:        ${all.length} (errors: ${errors})`);
  console.log(`Source bytes: ${(totalBytes/1024/1024).toFixed(2)} MB`);
  console.log(`Sessions:     ${sessCount}`);
  console.log(`Messages:     ${rowCount} (added this run: ${totalAdded}, scanned: ${totalScanned})`);
  console.log(`DB size:      ${(dbStat.size/1024/1024).toFixed(2)} MB`);
  console.log(`Elapsed:      ${fmtMs(elapsedMs)}`);
}

main();
