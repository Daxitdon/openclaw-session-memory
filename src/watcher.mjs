// session-memory live watcher
import chokidar from 'chokidar';
import path from 'node:path';
import { Indexer } from './indexer.mjs';

const SESSIONS_DIR = process.env.SESSIONS_ROOT
  || process.env.SESSIONS_DIR
  || `${process.env.HOME}/.openclaw/agents`;
const DB_PATH = process.env.DB_PATH
  || `${process.env.HOME}/.openclaw/state/session-memory.db`;

const DEBOUNCE_MS = 500;

function logJson(obj) {
  process.stderr.write(JSON.stringify({ ts: Date.now(), ...obj }) + '\n');
}

export function startWatcher({ sessionsDir = SESSIONS_DIR, dbPath = DB_PATH } = {}) {
  const indexer = new Indexer(dbPath);
  const timers = new Map(); // path -> timeout

  function scheduleIndex(filePath) {
    if (!filePath.endsWith('.jsonl')) return;
    if (!filePath.includes(`${path.sep}sessions${path.sep}`)) return;
    if (filePath.includes('.checkpoint.')) return;
    if (path.basename(filePath).startsWith('__sm_watcher_test_')) return;
    // ignore obvious non-session files
    if (filePath.includes('.deleted.')) return;
    // skip companion trajectory artifacts (duplicates of session content)
    if (filePath.endsWith('.trajectory.jsonl')) return;
    if (filePath.endsWith('.trajectory-path.json')) return;
    const prev = timers.get(filePath);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      timers.delete(filePath);
      const t0 = Date.now();
      try {
        const { added, scanned } = indexer.indexFile(filePath);
        logJson({
          event: 'indexed',
          path: filePath,
          new_rows: added,
          scanned,
          ms: Date.now() - t0,
        });
      } catch (e) {
        logJson({ event: 'index_error', path: filePath, error: String(e && e.message || e) });
      }
    }, DEBOUNCE_MS);
    timers.set(filePath, t);
  }

  const watcher = chokidar.watch(path.join(sessionsDir, '**/*.jsonl'), {
    persistent: true,
    ignoreInitial: false,
    depth: undefined,
    awaitWriteFinish: false,
  });

  watcher
    .on('add', (p) => { logJson({ event: 'add', path: p }); scheduleIndex(p); })
    .on('change', (p) => { scheduleIndex(p); })
    .on('error', (err) => { logJson({ event: 'watcher_error', error: String(err) }); })
    .on('ready', () => { logJson({ event: 'watcher_ready', dir: sessionsDir }); });

  function shutdown(sig) {
    logJson({ event: 'shutdown', signal: sig });
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    watcher.close().finally(() => {
      try { indexer.close(); } catch {}
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { watcher, indexer };
}

// Allow running directly: `node src/watcher.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  startWatcher();
}
