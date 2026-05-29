#!/usr/bin/env node
// configure-openclaw.mjs — safely merge session-memory into ~/.openclaw/openclaw.json.
// Idempotent. Backs up the config first. Never clobbers unrelated keys.
//
// Usage:
//   node scripts/configure-openclaw.mjs            # merge into real config (with backup)
//   CONFIG_PATH=/path/to/openclaw.json node ...    # target a specific config (for testing)
//   DRY_RUN=1 node ...                             # print the merged result, write nothing
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(os.homedir(), '.openclaw', 'openclaw.json');
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 13579}`;
const DRY_RUN = !!process.env.DRY_RUN;

const TOOLS = ['session_search', 'session_recall', 'session_bookmark_save', 'session_relationship_save'];

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`✗ config not found: ${CONFIG_PATH}`);
  console.error('  Set CONFIG_PATH or run OpenClaw once to generate it.');
  process.exit(1);
}

const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
let cfg;
try { cfg = JSON.parse(raw); }
catch (e) { console.error(`✗ config is not valid JSON: ${e.message}`); process.exit(1); }

function ensureArrUnique(arr, val) {
  if (!Array.isArray(arr)) arr = [];
  if (!arr.includes(val)) arr.push(val);
  return arr;
}

// --- merge plugins ---
cfg.plugins ||= {};
cfg.plugins.allow = ensureArrUnique(cfg.plugins.allow, 'session-memory');

cfg.plugins.slots ||= {};
if (cfg.plugins.slots.memory && cfg.plugins.slots.memory !== 'session-memory') {
  console.warn(`⚠ plugins.slots.memory is currently "${cfg.plugins.slots.memory}" — overriding to "session-memory".`);
  console.warn(`  (your previous memory provider will be disabled; revert from the backup if unwanted)`);
}
cfg.plugins.slots.memory = 'session-memory';

cfg.plugins.entries ||= {};
const existing = cfg.plugins.entries['session-memory']?.config || {};
cfg.plugins.entries['session-memory'] = {
  enabled: true,
  config: {
    base_url: BASE_URL,
    timeout_ms: 3000,
    inject_context: true,
    context_min_confidence: 0.42,
    context_limit: 5,
    ...existing,        // preserve any user overrides
    base_url: existing.base_url || BASE_URL,
  },
};

// --- merge tools.alsoAllow ---
cfg.tools ||= {};
for (const t of TOOLS) cfg.tools.alsoAllow = ensureArrUnique(cfg.tools.alsoAllow, t);

const out = JSON.stringify(cfg, null, 2) + '\n';

// validate round-trip
try { JSON.parse(out); } catch (e) { console.error(`✗ refusing to write — merged JSON invalid: ${e.message}`); process.exit(1); }

if (DRY_RUN) {
  console.log('--- DRY RUN (no write) — merged plugins + tools blocks ---');
  console.log(JSON.stringify({ plugins: cfg.plugins, 'tools.alsoAllow': cfg.tools.alsoAllow }, null, 2));
  process.exit(0);
}

// backup then write
const backup = `${CONFIG_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.copyFileSync(CONFIG_PATH, backup);
fs.writeFileSync(CONFIG_PATH, out);
console.log(`✅ configured ${CONFIG_PATH}`);
console.log(`   backup: ${backup}`);
console.log(`   plugins.slots.memory = session-memory`);
console.log(`   tools.alsoAllow += ${TOOLS.join(', ')}`);
console.log('\nNext: restart your OpenClaw gateway to load the tools.');
