#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Searcher } from '../src/search.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const DB_PATH = process.env.DB_PATH || (process.env.HOME + '/.openclaw/state/session-memory.db');
const GOLDEN = process.argv[2] || path.join(ROOT, 'evals/session-memory-golden.jsonl');
const OUT_DIR = process.env.OUT_DIR || `${process.env.HOME}/.openclaw/reports/session-memory-evals`;
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const TOP_LIMIT = Number(process.env.TOP_LIMIT || 10);
const MIN_PASS_RATE = Number(process.env.MIN_PASS_RATE || 98);
const MIN_MRR = Number(process.env.MIN_MRR || 0);
const MAX_P95_MS = Number(process.env.MAX_P95_MS || 150);

function loadJsonl(file) {
  return fs.readFileSync(file, 'utf8')
    .split(/\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      try { return JSON.parse(l); }
      catch (e) { throw new Error(`${file}:${i+1} invalid JSON: ${e.message}`); }
    });
}

function norm(s) { return String(s || '').toLowerCase(); }
function includesAny(text, arr = []) { return !arr.length || arr.some(x => norm(text).includes(norm(x))); }
function includesAll(text, arr = []) { return !arr.length || arr.every(x => norm(text).includes(norm(x))); }
function median(xs) { if (!xs.length) return 0; const s=[...xs].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; }
function pct(xs, p) { if (!xs.length) return 0; const s=[...xs].sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.floor((p/100)*s.length))]; }

function fullContent(searcher, row) {
  if (row.summary || row.title) return `${row.title || ''}\n${row.summary || ''}\n${row.tags || ''}`;
  if (row.session_key && row.line_no && row.jsonl_path) {
    const msg = searcher.db.prepare('SELECT content FROM messages WHERE session_key=? AND jsonl_path=? AND line_no=?').get(row.session_key, row.jsonl_path, row.line_no);
    if (msg?.content) return msg.content;
  }
  return row.snippet || '';
}

function isMatch(searcher, row, expected = {}) {
  const text = fullContent(searcher, row);
  if (expected.session_key_contains && !norm(row.session_key).includes(norm(expected.session_key_contains))) return false;
  if (expected.title_any && !includesAny(row.title || '', expected.title_any)) return false;
  if (!includesAny(text, expected.content_any || [])) return false;
  if (!includesAll(text, expected.content_all || [])) return false;
  return true;
}

function dupStats(rows) {
  const seen = new Set();
  let dup = 0;
  for (const r of rows) {
    const bucket = r.session_key ? `${r.session_key}:${Math.floor((r.ts || 0) / (5 * 60 * 1000))}` : `bookmark:${r.id}`;
    if (seen.has(bucket)) dup++;
    seen.add(bucket);
  }
  return { duplicate_count: dup, duplicate_rate: rows.length ? dup / rows.length : 0 };
}

function evaluateOne(searcher, tc) {
  const t0 = process.hrtime.bigint();
  const rows = tc.source === 'bookmarks'
    ? searcher.searchBookmarks(tc.query, { limit: TOP_LIMIT })
    : searcher.search(tc.query, { limit: TOP_LIMIT });
  const latency_ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const grouped = tc.source === 'bookmarks'
    ? []
    : searcher.searchGrouped(tc.query, { limit: TOP_LIMIT });
  const expectedTopK = tc.expected?.topK || 5;
  let firstRank = null;
  for (let i = 0; i < rows.length; i++) {
    if (i < expectedTopK && isMatch(searcher, rows[i], tc.expected)) { firstRank = i + 1; break; }
  }
  const ds = dupStats(rows);
  return {
    id: tc.id,
    query: tc.query,
    type: tc.type || 'unknown',
    source: tc.source || 'search',
    pass: firstRank !== null,
    first_rank: firstRank,
    reciprocal_rank: firstRank ? 1 / firstRank : 0,
    latency_ms,
    topK: expectedTopK,
    result_count: rows.length,
    grouped_count: grouped.length,
    grouped_compression: rows.length ? 1 - (grouped.length / rows.length) : 0,
    ...ds,
    top_results: rows.slice(0, 5).map((r, i) => ({
      rank: i + 1,
      session_key: r.session_key,
      ts: r.ts,
      line_no: r.line_no,
      role: r.role,
      title: r.title,
      score: r.score,
      raw_score: r.raw_score,
      snippet: String(r.snippet || r.summary || '').replace(/\s+/g, ' ').slice(0, 300),
    })),
  };
}

function mdReport(summary, results) {
  const fails = results.filter(r => !r.pass);
  const byType = [...new Set(results.map(r => r.type))].sort().map(type => {
    const xs = results.filter(r => r.type === type);
    const pass = xs.filter(r => r.pass).length;
    return `| ${type} | ${pass}/${xs.length} | ${(pass/xs.length*100).toFixed(1)}% |`;
  }).join('\n');
  const failMd = fails.length ? fails.map(r => `- **${r.id}** \`${r.query}\` — top result: ${r.top_results[0]?.snippet || 'NO RESULTS'}`).join('\n') : '- None 🎉';
  return `# session-memory eval report\n\nRun: ${summary.run_id}\nGolden file: \`${summary.golden}\`\n\n## Summary\n- Cases: **${summary.total}**\n- Passed: **${summary.passed}/${summary.total} (${summary.pass_rate_pct.toFixed(1)}%)**\n- MRR: **${summary.mrr.toFixed(3)}**\n- Avg duplicate rate: **${(summary.avg_duplicate_rate*100).toFixed(1)}%**\n- Avg grouped compression: **${(summary.avg_grouped_compression*100).toFixed(1)}%**\n- Latency p50/p95: **${summary.latency_p50_ms.toFixed(2)}ms / ${summary.latency_p95_ms.toFixed(2)}ms**\n\n## By type\n| Type | Pass | Rate |\n|---|---:|---:|\n${byType}\n\n## Failures\n${failMd}\n\n## Notes\n- A pass means an acceptable source/result appeared within each case's expected topK.\n- Duplicate rate buckets results by session + 5-minute window, so it catches repeated adjacent hits.\n- Grouped compression estimates how much grouped=true collapses row-level results into episodes.\n- Use this before/after ranking changes; do not trust subjective search quality alone.\n`;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const cases = loadJsonl(GOLDEN);
const searcher = new Searcher(DB_PATH);
const results = cases.map(tc => evaluateOne(searcher, tc));
searcher.close();
const lat = results.map(r => r.latency_ms);
const passed = results.filter(r => r.pass).length;
const summary = {
  run_id: RUN_ID,
  golden: GOLDEN,
  db_path: DB_PATH,
  total: results.length,
  passed,
  pass_rate_pct: passed / results.length * 100,
  mrr: results.reduce((a, r) => a + r.reciprocal_rank, 0) / results.length,
  avg_duplicate_rate: results.reduce((a, r) => a + r.duplicate_rate, 0) / results.length,
  avg_grouped_compression: results.reduce((a, r) => a + r.grouped_compression, 0) / results.length,
  latency_p50_ms: median(lat),
  latency_p95_ms: pct(lat, 95),
};
const outJson = path.join(OUT_DIR, `eval-${RUN_ID}.json`);
const outMd = path.join(OUT_DIR, `eval-${RUN_ID}.md`);
const latestJson = path.join(OUT_DIR, 'latest.json');
const latestMd = path.join(OUT_DIR, 'latest.md');
fs.writeFileSync(outJson, JSON.stringify({ summary, results }, null, 2));
fs.writeFileSync(outMd, mdReport(summary, results));
fs.copyFileSync(outJson, latestJson);
fs.copyFileSync(outMd, latestMd);
console.log(JSON.stringify(summary, null, 2));
console.log(`Wrote ${outMd}`);
const failures = [];
if (summary.pass_rate_pct < MIN_PASS_RATE) failures.push(`pass_rate ${summary.pass_rate_pct.toFixed(1)} < ${MIN_PASS_RATE}`);
if (summary.mrr < MIN_MRR) failures.push(`mrr ${summary.mrr.toFixed(3)} < ${MIN_MRR}`);
if (summary.latency_p95_ms > MAX_P95_MS) failures.push(`p95 ${summary.latency_p95_ms.toFixed(2)}ms > ${MAX_P95_MS}ms`);
if (failures.length) {
  console.error(`Search eval threshold failure: ${failures.join('; ')}`);
  process.exit(1);
}
