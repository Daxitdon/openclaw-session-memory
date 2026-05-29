#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Searcher } from '../src/search.mjs';
import { buildContext } from '../src/context.mjs';

const DB_PATH = process.env.DB_PATH || (process.env.HOME + '/.openclaw/state/session-memory.db');
const GOLDEN = process.argv[2] || process.env.CONTEXT_GOLDEN || 'evals/context-golden.jsonl';
const OUT_DIR = process.env.OUT_DIR || `${process.env.HOME}/.openclaw/reports/session-memory-context-evals`;
const MIN_PASS_RATE = Number(process.env.MIN_PASS_RATE || 98);
const MAX_P95_MS = Number(process.env.MAX_P95_MS || 150);

function readJsonl(p) {
  return fs.readFileSync(p, 'utf8').split(/\n/).filter(Boolean).map(l => JSON.parse(l));
}
function pct(n) { return `${(n * 100).toFixed(1)}%`; }

const cases = readJsonl(GOLDEN);
const searcher = new Searcher(DB_PATH, { readonly: true });
const results = [];
const latencies = [];
for (const c of cases) {
  const t0 = process.hrtime.bigint();
  const ctx = buildContext(searcher, c.query, { limit: 5, minConfidence: 0.42 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  latencies.push(ms);
  const text = `${ctx.prependContext || ''} ${JSON.stringify(ctx.items || [])}`.toLowerCase();
  const injectOk = Boolean(ctx.injected) === Boolean(c.shouldInject);
  const containsOk = !c.mustContain || c.mustContain.every(s => text.includes(String(s).toLowerCase()));
  const passed = injectOk && containsOk;
  results.push({ id: c.id, query: c.query, shouldInject: c.shouldInject, injected: ctx.injected, reason: ctx.reason, item_count: ctx.item_count || 0, mustContain: c.mustContain || [], passed, latency_ms: ms, first: ctx.items?.[0] || null });
}
searcher.close();

const passed = results.filter(r => r.passed).length;
latencies.sort((a,b)=>a-b);
const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const summary = { run_id: runId, golden: GOLDEN, total: results.length, passed, pass_rate_pct: passed / results.length * 100, latency_p50_ms: p50, latency_p95_ms: p95 };
fs.mkdirSync(OUT_DIR, { recursive: true });
const jsonPath = path.join(OUT_DIR, `context-${runId}.json`);
const mdPath = path.join(OUT_DIR, `context-${runId}.md`);
fs.writeFileSync(jsonPath, JSON.stringify({ summary, results }, null, 2) + '\n');
fs.writeFileSync(path.join(OUT_DIR, 'latest.json'), JSON.stringify({ summary, results }, null, 2) + '\n');
const failures = results.filter(r => !r.passed);
const md = [
  '# session-memory context eval report',
  '',
  `Run: ${runId}`,
  `Golden: \`${GOLDEN}\``,
  '',
  '## Summary',
  `- Cases: **${results.length}**`,
  `- Passed: **${passed}/${results.length} (${pct(passed / results.length)})**`,
  `- Latency p50/p95: **${p50.toFixed(2)}ms / ${p95.toFixed(2)}ms**`,
  '',
  '## Failures',
  ...(failures.length ? failures.map(f => `- **${f.id}** ${f.query} — expected inject=${f.shouldInject}, got inject=${f.injected}, first=${f.first?.source || f.reason || 'none'}`) : ['None']),
  '',
  '## Cases',
  ...results.map(r => `- ${r.passed ? '✅' : '❌'} **${r.id}** inject=${r.injected} items=${r.item_count} — ${r.query}`),
  '',
  `JSON: ${jsonPath}`,
].join('\n');
fs.writeFileSync(mdPath, md + '\n');
fs.writeFileSync(path.join(OUT_DIR, 'latest.md'), md + '\n');
console.log(JSON.stringify(summary, null, 2));
if (failures.length) {
  console.error(`Context eval failed: ${failures.length} failures`);
  process.exit(1);
}
const thresholdFailures = [];
if (summary.pass_rate_pct < MIN_PASS_RATE) thresholdFailures.push(`pass_rate ${summary.pass_rate_pct.toFixed(1)} < ${MIN_PASS_RATE}`);
if (summary.latency_p95_ms > MAX_P95_MS) thresholdFailures.push(`p95 ${summary.latency_p95_ms.toFixed(2)}ms > ${MAX_P95_MS}ms`);
if (thresholdFailures.length) {
  console.error(`Context eval threshold failure: ${thresholdFailures.join('; ')}`);
  process.exit(1);
}
