#!/usr/bin/env node
// Bench: run a handful of queries, report latencies.
import os from 'node:os';
import path from 'node:path';
import { Searcher } from '../src/search.mjs';

const HOME = os.homedir();
const DB_PATH = process.env.DB_PATH || path.join(HOME, '.openclaw/state/session-memory.db');

const QUERIES = [
  'example query',
  'claude-opus',
  'lcm compaction',
  'keyword',
  'database',
];

function fmtUs(ns) {
  const us = Number(ns) / 1000;
  if (us < 1000) return `${us.toFixed(1)}µs`;
  return `${(us/1000).toFixed(2)}ms`;
}

function run(searcher, q, opts = {}) {
  const t0 = process.hrtime.bigint();
  const rows = searcher.search(q, { limit: 10, ...opts });
  const t1 = process.hrtime.bigint();
  return { rows, elapsed: t1 - t0 };
}

function main() {
  const s = new Searcher(DB_PATH);
  console.log(`DB: ${DB_PATH}`);

  // Warm
  run(s, 'warm up query never matches xyzqq');

  for (const q of QUERIES) {
    const { rows, elapsed } = run(s, q);
    console.log(`\n[${q}]  ${rows.length} hits in ${fmtUs(elapsed)}`);
    for (const r of rows.slice(0, 3)) {
      const snip = (r.snippet || '').replace(/\s+/g, ' ').slice(0, 140);
      console.log(`  · score=${r.score.toFixed(2)}  ${r.session_key.slice(0,8)}…  ${new Date(r.ts).toISOString()}`);
      console.log(`    ${snip}`);
    }
  }

  // Trigram comparison on one
  const { rows: tg, elapsed: tge } = run(s, 'example', { trigram: true });
  console.log(`\n[trigram: example]  ${tg.length} hits in ${fmtUs(tge)}`);

  s.close();
}

main();
