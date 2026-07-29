// Full-text search across every past conversation turn: SQLite FTS5 over
// all session messages, so "what did we talk about regarding X" is
// answerable without relying on the curated MEMORY.md-style summaries
// (acp-memory-store.js), which only ever keep a compacted gist, not the raw
// text. This module is purely an index -- acp-memory-store.js remains the
// source of truth for session content; losing this DB just means search
// stops working, nothing is lost.
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const DEFAULT_DB_PATH = path.join(__dirname, "data", "acp-memory", "session-search.db");

// options.dbPath: injectable so tests never write into node-bot's real data
// directory (same pattern as acp-memory-store.js/approval-gate.js).
function createSessionSearchIndex(options = {}) {
  const dbPath = options.dbPath || DEFAULT_DB_PATH;
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      sessionId UNINDEXED,
      role UNINDEXED,
      text,
      at UNINDEXED
    );
  `);

  const insertStmt = db.prepare(
    "INSERT INTO messages_fts (sessionId, role, text, at) VALUES (?, ?, ?, ?)",
  );

  // Indexes one turn's user/assistant text (whichever fields are present).
  // Safe to call for every appendTurn -- a turn with only a user message
  // (no assistant reply yet) still gets that half indexed.
  function indexTurn({ sessionId, turn } = {}) {
    if (!sessionId || !turn) return;
    const at = turn.at || new Date().toISOString();
    const rows = [];
    if (turn.user) rows.push([sessionId, "user", turn.user, at]);
    if (turn.assistant) rows.push([sessionId, "assistant", turn.assistant, at]);
    if (!rows.length) return;
    const insertMany = db.transaction((entries) => {
      for (const entry of entries) insertStmt.run(...entry);
    });
    insertMany(rows);
  }

  // FTS5 query syntax is passed straight through (phrases in quotes,
  // AND/OR/NOT, prefix* -- see https://sqlite.org/fts5.html#full_text_query_syntax)
  // so the model doesn't need a second query language to learn.
  function search({ query, limit = 20, sort = "relevance", roleFilter, sessionId } = {}) {
    if (!query || !String(query).trim()) return [];
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 20));

    const conditions = ["messages_fts MATCH ?"];
    const params = [String(query)];
    if (sessionId) {
      conditions.push("sessionId = ?");
      params.push(String(sessionId));
    }
    if (Array.isArray(roleFilter) && roleFilter.length) {
      conditions.push(`role IN (${roleFilter.map(() => "?").join(",")})`);
      params.push(...roleFilter);
    }

    const orderClause =
      sort === "newest" ? "at DESC" : sort === "oldest" ? "at ASC" : "rank";

    const rows = db
      .prepare(
        `SELECT sessionId, role, text, at, rank FROM messages_fts
         WHERE ${conditions.join(" AND ")}
         ORDER BY ${orderClause}
         LIMIT ?`,
      )
      .all(...params, safeLimit);

    return rows.map((row) => ({
      sessionId: row.sessionId,
      role: row.role,
      text: row.text,
      at: row.at,
    }));
  }

  function close() {
    db.close();
  }

  return { indexTurn, search, close };
}

module.exports = { createSessionSearchIndex, DEFAULT_DB_PATH };
