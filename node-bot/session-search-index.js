// Full-text search across every past conversation turn: SQLite FTS5 over
// all session messages, so "what did we talk about regarding X" is
// answerable without relying on the curated MEMORY.md-style summaries
// (acp-memory-store.js), which only ever keep a compacted gist, not the raw
// text. This module is purely an index -- acp-memory-store.js remains the
// source of truth for session content; losing this DB just means search
// stops working, nothing is lost.
//
// Issue #263 part 1: also an optional vec0 (sqlite-vec) semantic index over
// the same database file, alongside FTS5 -- see indexEmbedding()/search()'s
// queryEmbedding param below. Vector search is a pure enhancement: if
// sqlite-vec's extension fails to load for any reason (unsupported
// platform, missing prebuild), vectorEnabled stays false and every existing
// keyword-only behavior is completely unaffected.
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { significantWords, sharedWordCount } = require("./utils/word-overlap");

const DEFAULT_DB_PATH = path.join(__dirname, "data", "acp-memory", "session-search.db");

// Matches local_embedder.py's default model (all-MiniLM-L6-v2). vec0's
// table dimension is fixed at creation time -- if RETRIEVER_EMBEDDER_MODEL
// is ever swapped for a different-dimension model, indexEmbedding() below
// just skips (dimension mismatch), it doesn't crash. Not solved further
// here since nothing in this codebase swaps the embedder model at runtime
// today.
const DEFAULT_EMBED_DIM = 384;

// A candidate whose text overlaps an already-kept result by more than this
// fraction of its own significant words is treated as a near-duplicate and
// dropped -- see mergeResults() below.
const DIVERSITY_OVERLAP_THRESHOLD = 0.7;

// options.dbPath: injectable so tests never write into node-bot's real data
// directory (same pattern as acp-memory-store.js/approval-gate.js).
// options.embedDim: injectable so tests can use small deterministic vectors
// instead of real 384-dim ones.
function createSessionSearchIndex(options = {}) {
  const dbPath = options.dbPath || DEFAULT_DB_PATH;
  const embedDim = Math.max(1, Number(options.embedDim) || DEFAULT_EMBED_DIM);
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

  let vectorEnabled = false;
  let vecInsertStmt = null;
  let vecMetaInsertStmt = null;
  let vecCandidatesStmt = null;
  let vecMetaLookupStmt = null;
  try {
    const sqliteVec = require("sqlite-vec");
    db.loadExtension(sqliteVec.getLoadablePath());
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS turns_vec USING vec0(
        embedding float[${embedDim}] distance_metric=cosine
      );
      CREATE TABLE IF NOT EXISTS turns_vec_meta (
        rowid INTEGER PRIMARY KEY,
        sessionId TEXT,
        text TEXT,
        at TEXT
      );
    `);
    vecInsertStmt = db.prepare("INSERT INTO turns_vec (embedding) VALUES (vec_f32(?))");
    vecMetaInsertStmt = db.prepare(
      "INSERT INTO turns_vec_meta (rowid, sessionId, text, at) VALUES (?, ?, ?, ?)",
    );
    vecCandidatesStmt = db.prepare(
      "SELECT rowid, distance FROM turns_vec WHERE embedding MATCH vec_f32(?) ORDER BY distance LIMIT ?",
    );
    vecMetaLookupStmt = db.prepare(
      "SELECT sessionId, text, at FROM turns_vec_meta WHERE rowid = ?",
    );
    vectorEnabled = true;
  } catch (e) {
    // sqlite-vec unavailable on this platform, or the extension failed to
    // load -- keyword search (FTS5, already set up above) keeps working on
    // its own. Hybrid search is additive, never a hard requirement.
    console.warn("Session search: vector index unavailable, keyword-only:", e?.message || e);
  }

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

  // Indexes one turn's combined text as a single embedding (whole-turn, not
  // per-role -- half the embedding calls of indexTurn's per-role FTS5 rows,
  // and matches how a search question usually spans both sides of a turn).
  // Caller (acp-memory-store.js) computes the embedding; this module never
  // calls out to an embedder itself, same separation retriever-index.js's
  // callers already follow. A no-op if vector search isn't available, or
  // the embedding's dimension doesn't match this index's fixed table
  // dimension (e.g. the embedder model was swapped after this DB was
  // created).
  function indexEmbedding({ sessionId, turn, embedding } = {}) {
    if (!vectorEnabled || !sessionId || !turn) return;
    if (!Array.isArray(embedding) || embedding.length !== embedDim) return;
    const text = `User: ${turn.user || ""}\nAssistant: ${turn.assistant || ""}`.trim();
    if (!text) return;
    const at = turn.at || new Date().toISOString();
    const insertBoth = db.transaction(() => {
      const info = vecInsertStmt.run(JSON.stringify(embedding));
      vecMetaInsertStmt.run(info.lastInsertRowid, sessionId, text, at);
    });
    insertBoth();
  }

  // Global KNN search over turns_vec, joined against turns_vec_meta,
  // optionally filtered to one session. Over-fetches from the vec0 MATCH
  // query before filtering by sessionId, since vec0 applies its own
  // ORDER BY distance LIMIT before any WHERE filter could run -- a plain
  // `LIMIT limit` here could return zero session-scoped hits even when good
  // ones exist, if other sessions dominate the global top-k. 500 is a
  // generous ceiling for Mana's realistic per-session turn counts, and this
  // is a local SQLite DB, so the extra lookups are cheap.
  function vectorSearch(queryEmbedding, limit, sessionId) {
    if (!vectorEnabled) return [];
    try {
      const fetchCap = sessionId ? 500 : limit;
      const candidates = vecCandidatesStmt.all(JSON.stringify(queryEmbedding), fetchCap);
      const results = [];
      for (const row of candidates) {
        const meta = vecMetaLookupStmt.get(row.rowid);
        if (!meta) continue;
        if (sessionId && meta.sessionId !== sessionId) continue;
        results.push({
          sessionId: meta.sessionId,
          role: "turn",
          text: meta.text,
          at: meta.at,
          matchType: "semantic",
        });
        if (results.length >= limit) break;
      }
      return results;
    } catch (e) {
      // A dimension mismatch (queryEmbedding computed by a different model
      // than what indexed these rows) or any other vec0 query error --
      // keyword results still stand on their own.
      return [];
    }
  }

  // Interleaves two ranked lists (best-first from each), then drops any
  // candidate whose text is a near-duplicate of one already kept -- so a
  // semantic hit that just restates a keyword hit doesn't eat a results
  // slot. Simple token-overlap check, same technique
  // skills-capability.js/acp-memory-store.js already use elsewhere.
  function mergeResults(keywordResults, vectorResults, limit) {
    const interleaved = [];
    const max = Math.max(keywordResults.length, vectorResults.length);
    for (let i = 0; i < max; i += 1) {
      if (keywordResults[i]) interleaved.push(keywordResults[i]);
      if (vectorResults[i]) interleaved.push(vectorResults[i]);
    }

    const kept = [];
    const keptWords = [];
    for (const candidate of interleaved) {
      const words = significantWords(candidate.text);
      const isDuplicate = words.length
        ? keptWords.some(
            (kw) => kw.length && sharedWordCount(words, kw) / Math.min(words.length, kw.length) > DIVERSITY_OVERLAP_THRESHOLD,
          )
        : false;
      if (isDuplicate) continue;
      kept.push(candidate);
      keptWords.push(words);
      if (kept.length >= limit) break;
    }
    return kept;
  }

  // FTS5 query syntax is passed straight through (phrases in quotes,
  // AND/OR/NOT, prefix* -- see https://sqlite.org/fts5.html#full_text_query_syntax)
  // so the model doesn't need a second query language to learn.
  //
  // queryEmbedding (issue #263 part 1, optional): when provided alongside
  // the default "relevance" sort and no roleFilter, keyword results are
  // blended with a semantic (vec0) search over the same query and
  // reranked for diversity. Skipped for "newest"/"oldest" sort (an
  // explicit request to bypass relevance ranking entirely) and for an
  // explicit roleFilter (vector hits are whole-turn, not per-role, so they
  // can't honestly satisfy a user/assistant-only filter) -- in both cases
  // behavior is unchanged from keyword-only search.
  function search({
    query,
    limit = 20,
    sort = "relevance",
    roleFilter,
    sessionId,
    queryEmbedding,
    since,
    until,
  } = {}) {
    const hasQuery = Boolean(query && String(query).trim());
    // Issue #337: a purely temporal question ("what did we discuss
    // yesterday") has no keywords left once the date expression is removed,
    // so a time window on its own is a valid search. Only a request with
    // neither is empty.
    if (!hasQuery && !since && !until) return [];
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 20));

    const useHybrid =
      hasQuery &&
      vectorEnabled &&
      Array.isArray(queryEmbedding) &&
      queryEmbedding.length === embedDim &&
      sort === "relevance" &&
      !(Array.isArray(roleFilter) && roleFilter.length);

    // Over-fetch keyword candidates when merging with vector results, so
    // the diversity filter above has real alternatives to pick from
    // instead of starving the final count when a few keyword hits get
    // dropped as near-duplicates of vector hits.
    const fetchLimit = useHybrid ? Math.min(200, safeLimit * 3) : safeLimit;

    const conditions = [];
    const params = [];
    if (hasQuery) {
      conditions.push("messages_fts MATCH ?");
      params.push(String(query));
    }
    if (sessionId) {
      conditions.push("sessionId = ?");
      params.push(String(sessionId));
    }
    if (Array.isArray(roleFilter) && roleFilter.length) {
      conditions.push(`role IN (${roleFilter.map(() => "?").join(",")})`);
      params.push(...roleFilter);
    }
    // Issue #337: half-open [since, until) so adjacent windows -- yesterday
    // and today -- cannot both claim the same midnight turn.
    if (since) {
      conditions.push("at >= ?");
      params.push(String(since));
    }
    if (until) {
      conditions.push("at < ?");
      params.push(String(until));
    }

    // `rank` is only meaningful alongside a MATCH, so a time-only search
    // falls back to newest-first -- which is the order a "what did we
    // discuss yesterday" question wants anyway. An explicit "oldest" is
    // still honored: it is a request about ordering, not about ranking.
    const orderClause =
      sort === "oldest"
        ? "at ASC"
        : sort === "newest" || !hasQuery
          ? "at DESC"
          : "rank";

    const rows = db
      .prepare(
        `SELECT sessionId, role, text, at, rank FROM messages_fts
         WHERE ${conditions.join(" AND ")}
         ORDER BY ${orderClause}
         LIMIT ?`,
      )
      .all(...params, fetchLimit);

    const keywordResults = rows.map((row) => ({
      sessionId: row.sessionId,
      role: row.role,
      text: row.text,
      at: row.at,
      matchType: "keyword",
    }));

    if (!useHybrid) return keywordResults.slice(0, safeLimit);

    const vectorResults = vectorSearch(queryEmbedding, fetchLimit, sessionId);
    return mergeResults(keywordResults, vectorResults, safeLimit);
  }

  function close() {
    db.close();
  }

  // Exposed so callers (and tests) can tell whether the vector index
  // actually loaded -- e.g. sqlite-vec's platform binary being unavailable
  // in an environment (see the `catch` above) is a real, expected state,
  // not just an internal implementation detail.
  return { indexTurn, indexEmbedding, search, close, vectorEnabled: () => vectorEnabled };
}

module.exports = { createSessionSearchIndex, DEFAULT_DB_PATH, DEFAULT_EMBED_DIM };
