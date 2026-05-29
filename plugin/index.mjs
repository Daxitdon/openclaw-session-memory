import fs from "node:fs";
import path from "node:path";

/**
 * session-memory OCPlatform plugin
 *
 * Exposes two tools backed by the local session-memory HTTP service
 * (default http://127.0.0.1:13579):
 *   - session_search(query, limit?, session_key?, since?, until?, trigram?)
 *   - session_recall(session_key, around_ts, window?)
 * Optionally injects conservative source-linked context before an agent turn
 * via /context when inject_context is true.
 *
 * If the service is down, returns a clear actionable error message instead
 * of throwing — so the agent can recover the conversation.
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:13579";
const DEFAULT_TIMEOUT_MS = 5000;

const SEARCH_PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: {
      type: "string",
      description:
        "FTS5 query. Use a few distinctive terms (default AND) or a quoted phrase.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 200,
      description: "Max hits to return (default 20).",
    },
    session_key: {
      type: "string",
      description: "Restrict to a single session_key.",
    },
    role: {
      type: "string",
      description: "Filter by role (user/assistant/toolUse/toolResult).",
    },
    since: {
      type: "integer",
      description: "Only return rows with ts >= since (ms since epoch).",
    },
    until: {
      type: "integer",
      description: "Only return rows with ts <= until (ms since epoch).",
    },
    trigram: {
      type: "boolean",
      description: "Use trigram FTS index (substring-friendly) instead of token FTS.",
    },
  },
};

const RECALL_PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["session_key", "around_ts"],
  properties: {
    session_key: { type: "string", description: "Session key to recall from." },
    around_ts: {
      type: "integer",
      description: "Anchor timestamp (ms since epoch); typically the ts from a search hit.",
    },
    window: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description: "Number of messages before/after the anchor (default 10).",
    },
  },
};

const BOOKMARK_SAVE_PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "title", "summary"],
  properties: {
    kind: {
      type: "string",
      enum: ["note", "decision", "preference", "fact", "lesson", "incident", "rule", "architecture", "bug", "workflow"],
      description: "Durable memory type. Prefer decision/preference/fact/lesson/rule over generic note.",
    },
    title: { type: "string", description: "Short, specific title for the promoted memory." },
    summary: { type: "string", description: "Concise durable fact/decision/preference. Do not invent; link source when possible." },
    tags: { type: "string", description: "Comma-separated tags." },
    confidence: { type: "number", minimum: 0, maximum: 1, description: "0-1 confidence; unsourced saves are capped by the service." },
    session_key: { type: "string", description: "Source session key, if known." },
    ts: { type: "integer", description: "Source timestamp in ms epoch, if known." },
    jsonl_path: { type: "string", description: "Source JSONL path, if known." },
    line_no: { type: "integer", description: "Source line number, if known." },
    source_message_id: { type: "integer", description: "Source messages.id row, if known." },
    source_type: { type: "string", description: "Usually session; unsourced is allowed but lower-confidence." },
    force: { type: "boolean", description: "Create even if same kind/title already exists." },
    status: { type: "string", enum: ["active", "archived", "superseded"], description: "Memory lifecycle status." },
    valid_from: { type: "integer", description: "Optional validity start timestamp in ms epoch." },
    valid_to: { type: "integer", description: "Optional validity end timestamp in ms epoch; expired items are excluded from context." },
    supersedes_id: { type: "integer", description: "Bookmark id this new bookmark supersedes." },
  },
};

const RELATIONSHIP_SAVE_PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["from", "rel_type", "to"],
  properties: {
    from: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        type: { type: "string", description: "Entity type, e.g. project/tool/person/service/concept." },
        name: { type: "string", description: "Source entity name." },
      },
    },
    rel_type: { type: "string", description: "Typed relationship, e.g. CAUSED, HAS_STALE_LOGGING, PREFERS, USES." },
    to: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        type: { type: "string", description: "Entity type, e.g. project/tool/person/service/concept." },
        name: { type: "string", description: "Target entity name." },
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1, description: "0-1 confidence; unsourced saves are capped by service." },
    source_type: { type: "string", description: "Usually session; unsourced is allowed but lower-confidence." },
    source_id: { type: "integer", description: "Source message/bookmark id, if known." },
    session_key: { type: "string", description: "Source session key, if known." },
    ts: { type: "integer", description: "Source timestamp in ms epoch, if known." },
    status: { type: "string", enum: ["active", "archived", "superseded"], description: "Relationship lifecycle status." },
    valid_from: { type: "integer", description: "Optional validity start timestamp in ms epoch." },
    valid_to: { type: "integer", description: "Optional validity end timestamp in ms epoch; expired relationships are excluded from context." },
    supersedes_id: { type: "integer", description: "Relationship id this new relationship supersedes." },
  },
};

function makeClient(cfg, api) {
  const baseUrl = String(cfg.base_url || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = Number(cfg.timeout_ms || DEFAULT_TIMEOUT_MS);

  async function getJson(path, params) {
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return {
          error: `session-memory ${path} failed: ${res.status} ${body.slice(0, 300)}`,
        };
      }
      return await res.json();
    } catch (err) {
      const msg = String(err && err.message || err);
      const conn = /ECONNREFUSED|fetch failed|ENOTFOUND|abort/i.test(msg);
      api.logger?.warn?.(`session-memory: ${msg}`);
      return {
        error: conn
          ? "session-memory service not running, run: systemctl start session-memory.service"
          : `session-memory request failed: ${msg}`,
      };
    }
  }

  async function postJson(path, body) {
    const url = new URL(baseUrl + path);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { error: `session-memory ${path} failed: ${res.status} ${text.slice(0, 300)}` };
      }
      return await res.json();
    } catch (err) {
      const msg = String(err && err.message || err);
      api.logger?.warn?.(`session-memory: ${msg}`);
      return { error: `session-memory request failed: ${msg}` };
    }
  }

  return { getJson, postJson, baseUrl };
}

function safeCall(fn) {
  try { return typeof fn === "function" ? fn() : undefined; }
  catch { return undefined; }
}

function countJsonlLines(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const text = fs.readFileSync(file, "utf8");
    if (!text) return 0;
    return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
  } catch {
    return null;
  }
}

function sourceContextFromToolCtx(ctx) {
  const sm = ctx?.sessionManager;
  if (!sm) return {};
  const sessionFile = safeCall(() => sm.getSessionFile?.());
  const sessionId = safeCall(() => sm.getSessionId?.());
  const sessionKey = sessionFile
    ? path.basename(String(sessionFile), ".jsonl")
    : (sessionId ? String(sessionId) : undefined);
  const leaf = safeCall(() => sm.getLeafEntry?.());
  const entries = safeCall(() => sm.getEntries?.());
  const lastEntry = Array.isArray(entries) && entries.length ? entries[entries.length - 1] : null;
  const entryTs = leaf?.timestamp || lastEntry?.timestamp || null;
  const parsedTs = entryTs ? Date.parse(entryTs) : NaN;
  return {
    session_key: sessionKey || undefined,
    jsonl_path: sessionFile ? String(sessionFile) : undefined,
    line_no: sessionFile ? countJsonlLines(String(sessionFile)) : undefined,
    ts: Number.isFinite(parsedTs) ? parsedTs : Date.now(),
    source_type: sessionKey || sessionFile ? "session" : undefined,
  };
}

function withAutoSource(params, ctx, sourceIdField = null) {
  const auto = sourceContextFromToolCtx(ctx);
  const out = { source_type: "session", ...(params || {}) };
  for (const key of ["session_key", "ts", "jsonl_path", "line_no", "source_type"]) {
    if (out[key] === undefined || out[key] === null || out[key] === "") out[key] = auto[key];
  }
  if (sourceIdField && (out[sourceIdField] === undefined || out[sourceIdField] === null) && out.source_message_id) {
    out[sourceIdField] = out.source_message_id;
  }
  return out;
}

function makeSearchTool(client) {
  return {
    name: "session_search",
    label: "Session Search",
    description:
      "Full-text search across past OCPlatform session messages (FTS5). Returns recent matching snippets with session_key/ts/line_no for follow-up via session_recall.",
    parameters: SEARCH_PARAMS_SCHEMA,
    async execute(_toolCallId, params) {
      const res = await client.getJson("/search", {
        q: params.query,
        limit: params.limit,
        session_key: params.session_key,
        role: params.role,
        since: params.since,
        until: params.until,
        trigram: params.trigram,
      });
      if (res && typeof res === "object" && !Array.isArray(res) && res.error) {
        return { error: res.error };
      }
      return { hits: res };
    },
  };
}

function makeRecallTool(client) {
  return {
    name: "session_recall",
    label: "Session Recall",
    description:
      "Recall ±window messages around a given timestamp inside a session. Use after session_search to expand the surrounding context.",
    parameters: RECALL_PARAMS_SCHEMA,
    async execute(_toolCallId, params) {
      const res = await client.getJson("/recall", {
        session_key: params.session_key,
        around_ts: params.around_ts,
        window: params.window,
      });
      if (res && typeof res === "object" && !Array.isArray(res) && res.error) {
        return { error: res.error };
      }
      return { messages: res };
    },
  };
}

function makeBookmarkSaveTool(client) {
  return {
    name: "session_bookmark_save",
    label: "Session Bookmark Save",
    description:
      "Promote a durable memory into session-memory bookmarks. Use sparingly for decisions, preferences, rules, facts, incidents, lessons, or architecture. Prefer source-linked saves; do not auto-save routine conversation summaries.",
    parameters: BOOKMARK_SAVE_PARAMS_SCHEMA,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const res = await client.postJson("/bookmarks", withAutoSource(params, ctx));
      if (res && typeof res === "object" && res.error) return { error: res.error };
      return res;
    },
  };
}

function makeRelationshipSaveTool(client) {
  return {
    name: "session_relationship_save",
    label: "Session Relationship Save",
    description:
      "Promote a durable typed relationship into session-memory graph-lite. Use sparingly for source-linked rules/facts (e.g. ToolX CAUSED_ISSUES_WITH SystemY, or PersonA PREFERS conciseReplies). Prefer source-linked saves; do not infer weak relationships.",
    parameters: RELATIONSHIP_SAVE_PARAMS_SCHEMA,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const res = await client.postJson("/relationships", withAutoSource(params, ctx, "source_id"));
      if (res && typeof res === "object" && res.error) return { error: res.error };
      return res;
    },
  };
}

const plugin = {
  id: "session-memory",
  name: "session-memory",
  description:
    "Full-text search and recall across local OCPlatform session JSONLs via the session-memory HTTP service.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      base_url: { type: "string" },
      timeout_ms: { type: "number" },
      inject_context: { type: "boolean" },
      context_min_confidence: { type: "number" },
      context_limit: { type: "number" },
    },
  },
  register(api) {
    const cfg = {
      enabled: api.pluginConfig?.enabled !== false,
      base_url: api.pluginConfig?.base_url || DEFAULT_BASE_URL,
      timeout_ms: api.pluginConfig?.timeout_ms || DEFAULT_TIMEOUT_MS,
      inject_context: api.pluginConfig?.inject_context === true,
      context_min_confidence: api.pluginConfig?.context_min_confidence || 0.42,
      context_limit: api.pluginConfig?.context_limit || 5,
    };
    if (!cfg.enabled) {
      api.logger?.info?.("session-memory plugin disabled by config");
      return;
    }
    const client = makeClient(cfg, api);

    if (typeof api.registerMemoryCapability === "function") {
      api.registerMemoryCapability({
        promptBuilder: () => [
          "Long-term memory provider: session-memory (local SQLite FTS5 + bookmarks + graph-lite).",
          "Use session_search/session_recall for exact raw conversation recall; use session_bookmark_save sparingly to promote durable decisions, preferences, rules, facts, incidents, lessons, or architecture.",
          "Automatic context injection is gated and source-linked; treat it as background, not authority.",
        ],
      });
    }

    if (typeof api.registerTool !== "function") {
      api.logger?.warn?.(
        "session-memory: api.registerTool not available — tools NOT registered. Plugin loaded but inactive.",
      );
      return;
    }

    // Match the canonical OCPlatform 4.23 pattern (see extensions/firecrawl,
    // extensions/tavily): pass the tool object directly, not a factory.
    api.registerTool(makeSearchTool(client));
    api.registerTool(makeRecallTool(client));
    api.registerTool(makeBookmarkSaveTool(client));
    api.registerTool(makeRelationshipSaveTool(client));
    api.on?.("before_agent_start", async (event) => {
      if (!cfg.inject_context) return;
      const prompt = typeof event?.prompt === "string" ? event.prompt.trim() : "";
      if (!prompt) return;
      const res = await client.getJson("/context", {
        q: prompt,
        limit: cfg.context_limit,
        min_confidence: cfg.context_min_confidence,
      });
      if (!res?.injected || !res?.prependContext) return;
      return { prependContext: res.prependContext };
    });
    api.logger?.info?.(
      `session-memory: registered session_search + session_recall + session_bookmark_save + session_relationship_save (base=${client.baseUrl}, inject_context=${cfg.inject_context})`,
    );
  },
};

export default plugin;
