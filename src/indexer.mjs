// session-memory indexer
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { ensureEntityStatements, indexEntitiesForSource } from './entities.mjs';

const SCHEMA_PATH = new URL('./schema.sql', import.meta.url);

// Base64-ish blobs: long runs of base64 chars without spaces. Conservative threshold.
const BASE64_RE = /[A-Za-z0-9+/=]{120,}/g;
const MAX_TOOL_RESULT = 1000;

function deriveSessionMetaFromPath(jsonlPath) {
  const base = path.basename(jsonlPath, '.jsonl');
  // <uuid>(-topic-<num>)?
  const m = base.match(/^([0-9a-f-]{36})(?:-topic-(\d+))?$/i);
  const session_key = base;
  const topic_id = m && m[2] ? m[2] : null;
  // agent_id derived from path: .../agents/<agent>/sessions/...
  const parts = jsonlPath.split(path.sep);
  const ai = parts.indexOf('agents');
  const agent_id = ai >= 0 && parts[ai + 1] ? parts[ai + 1] : 'main';
  return { session_key, agent_id, topic_id };
}

function pushTextBlock(pieces, block) {
  if (!block || typeof block !== 'object') return;
  const t = block.type;
  // OpenAI/Codex session logs use input_text/output_text; OpenClaw/Anthropic
  // logs mostly use text. Index the human-readable parts for both formats.
  if ((t === 'text' || t === 'input_text' || t === 'output_text') && typeof block.text === 'string') {
    if (block.text.length > 0) pieces.push(block.text);
  }
}

export class Indexer {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('mmap_size = 268435456');
    this.applySchema();

    this.stmtMaxLine = this.db.prepare(
      'SELECT COALESCE(MAX(line_no), 0) AS m FROM messages WHERE jsonl_path = ?'
    );
    this.stmtUpsertSession = this.db.prepare(`
      INSERT INTO sessions (session_key, agent_id, channel, surface, topic_id, display, first_at, last_at, msg_count)
      VALUES (@session_key, @agent_id, @channel, @surface, @topic_id, @display, @ts, @ts, 0)
      ON CONFLICT(session_key) DO UPDATE SET
        first_at = MIN(first_at, excluded.first_at),
        last_at  = MAX(last_at, excluded.last_at)
    `);
    this.stmtBumpSession = this.db.prepare(`
      UPDATE sessions
         SET last_at = MAX(last_at, @ts),
             first_at = MIN(first_at, @ts),
             msg_count = msg_count + 1
       WHERE session_key = @session_key
    `);
    this.stmtInsertMessage = this.db.prepare(`
      INSERT OR IGNORE INTO messages
        (session_key, jsonl_path, line_no, role, msg_type, ts, content, has_image, has_tool, token_est)
      VALUES (@session_key, @jsonl_path, @line_no, @role, @msg_type, @ts, @content, @has_image, @has_tool, @token_est)
    `);
    this.stmtFindMessageId = this.db.prepare('SELECT id FROM messages WHERE jsonl_path = ? AND line_no = ?');
    this.entityStmts = ensureEntityStatements(this.db);
  }

  applySchema() {
    const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
    this.db.exec(sql);
  }

  close() {
    this.db.close();
  }

  /**
   * Flatten an OCPlatform jsonl line into an index row, or null if not indexable.
   * @returns {{role, msg_type, ts, content, has_image, has_tool}|null}
   */
  flatten(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : null;
    if (!ts || Number.isNaN(ts)) return null;

    // OpenClaw native JSONL format: { type: 'message', message: {...} }
    // Codex/ACP JSONL format: { type: 'response_item', payload: { type: 'message', ... } }
    let msg = null;
    if (obj.type === 'message' && obj.message) {
      msg = obj.message;
    } else if (obj.type === 'response_item' && obj.payload && obj.payload.type === 'message') {
      msg = obj.payload;
    } else {
      return null;
    }
    const role = msg.role || null;

    let has_image = 0;
    let has_tool = 0;
    const pieces = [];

    const content = msg.content;
    if (typeof content === 'string') {
      pieces.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const t = block.type;
        if (t === 'text' || t === 'input_text' || t === 'output_text') {
          pushTextBlock(pieces, block);
        } else if (t === 'thinking' || t === 'redacted_thinking') {
          // strip — noisy
          continue;
        } else if (t === 'tool_use') {
          has_tool = 1;
          const name = block.name || 'tool';
          pieces.push(`[tool:${name}]`);
        } else if (t === 'tool_result') {
          // anthropic-style tool result block
          has_tool = 1;
          const c = block.content;
          if (typeof c === 'string') {
            pieces.push(this.cleanToolResult(c));
          } else if (Array.isArray(c)) {
            for (const sub of c) {
              if (sub && sub.type === 'text' && typeof sub.text === 'string') {
                pieces.push(this.cleanToolResult(sub.text));
              } else if (sub && sub.type === 'image') {
                has_image = 1;
                pieces.push('[image]');
              }
            }
          }
        } else if (t === 'image') {
          has_image = 1;
          pieces.push('[image]');
        } else if (typeof block.text === 'string') {
          pieces.push(block.text);
        }
      }
    }

    // toolResult role (OpenClaw style): content is array of {type:text,text:...}
    if (role === 'toolResult' || role === 'tool') {
      has_tool = 1;
      // Already handled by content loop above, but apply cleaning if not cleaned
      // (the loop pushed raw text for type:text). Clean the whole concat below.
    }

    let text = pieces.join('\n').trim();
    if (!text) return null;

    if (role === 'toolResult' || role === 'tool') {
      text = this.cleanToolResult(text);
      if (!text) return null;
    }

    // Hard cap to keep FTS sane (most messages < 8k; assistant streams can be big)
    if (text.length > 16000) text = text.slice(0, 16000);

    const token_est = Math.ceil(text.length / 4);
    const msg_type = obj.type;

    return { role, msg_type, ts, content: text, has_image, has_tool, token_est };
  }

  cleanToolResult(s) {
    if (!s) return '';
    // Strip suspected base64 blobs
    let out = s.replace(BASE64_RE, '[b64]');
    if (out.length > MAX_TOOL_RESULT) out = out.slice(0, MAX_TOOL_RESULT) + '…';
    return out.trim();
  }

  /**
   * Index a single (already-parsed) line.
   */
  indexLine(jsonlPath, lineNo, obj, sessionMeta) {
    const flat = this.flatten(obj);
    if (!flat) return false;
    const meta = sessionMeta || deriveSessionMetaFromPath(jsonlPath);
    this.stmtUpsertSession.run({
      session_key: meta.session_key,
      agent_id: meta.agent_id,
      channel: meta.channel || null,
      surface: meta.surface || null,
      topic_id: meta.topic_id || null,
      display: meta.display || null,
      ts: flat.ts,
    });
    const info = this.stmtInsertMessage.run({
      session_key: meta.session_key,
      jsonl_path: jsonlPath,
      line_no: lineNo,
      role: flat.role,
      msg_type: flat.msg_type,
      ts: flat.ts,
      content: flat.content,
      has_image: flat.has_image,
      has_tool: flat.has_tool,
      token_est: flat.token_est,
    });
    if (info.changes > 0) {
      this.stmtBumpSession.run({ session_key: meta.session_key, ts: flat.ts });
      const msgRow = this.stmtFindMessageId.get(jsonlPath, lineNo);
      if (msgRow?.id) {
        indexEntitiesForSource(this.db, this.entityStmts, {
          source_type: 'message',
          source_id: msgRow.id,
          session_key: meta.session_key,
          ts: flat.ts,
          field: 'content',
          text: flat.content,
        });
      }
      return true;
    }
    return false;
  }

  /**
   * Backfill / incremental index of a single jsonl file.
   * Returns { added, scanned }.
   */
  indexFile(jsonlPath, onProgress) {
    const meta = deriveSessionMetaFromPath(jsonlPath);
    const startLine = this.stmtMaxLine.get(jsonlPath).m || 0;

    const raw = fs.readFileSync(jsonlPath, 'utf8');
    const lines = raw.split('\n');

    let added = 0;
    let scanned = 0;
    let batch = [];
    const BATCH = 500;

    const flush = this.db.transaction((rows) => {
      for (const r of rows) {
        if (this.indexLine(jsonlPath, r.lineNo, r.obj, meta)) added++;
      }
    });

    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      if (lineNo <= startLine) continue;
      const line = lines[i];
      if (!line) continue;
      scanned++;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (e) {
        console.warn(`[indexer] skip malformed ${jsonlPath}:${lineNo} ${e.message}`);
        continue;
      }
      batch.push({ lineNo, obj });
      if (batch.length >= BATCH) {
        flush(batch);
        batch = [];
        if (onProgress) onProgress({ added, scanned });
      }
    }
    if (batch.length) flush(batch);
    return { added, scanned, startLine };
  }
}

export { deriveSessionMetaFromPath };
