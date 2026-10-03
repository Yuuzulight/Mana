// Full-text search across every past conversation turn: SQLite FTS5 over
// all session messages, so "what did we talk about regarding X" is
// answerable without relying on the curated MEMORY.md-style summaries
// (acp-memory-store.js), which only ever keep a compacted gist, not the raw
// text. This module is purely an index -- acp-memory-store.js remains the
// source of truth for session content; losing this DB just means search
// stops working, nothing is lost.
//
// Issue #263 part 1: also an optional vec0 (sqlite-vec) semantic index over
// the same database file, alongside FTS5 -- see syncEmbeddings()/search()'s
// queryEmbedding param below. Vector search is a pure enhancement: if
// sqlite-vec's extension fails to load for any reason (unsupported
// platform, missing prebuild), vectorEnabled stays false and every existing
// keyword-only behavior is completely unaffected.
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { significantWords, sharedWordCount } = require("./utils/word-overlap");

// Beside the rest of memory: MANA_ACP_MEMORY_DIR moves it too.
const DEFAULT_DB_PATH = path.join(
  process.env.MANA_ACP_MEMORY_DIR || path.join(__dirname, "data", "acp-memory"),
  "session-search.db",
);

// vec0's dimension is fixed when the table is created, so turns_vec is
// (re)built from the first embedding the configured model actually returns
// (issue #263: it used to be hard-coded at 384 while Qwen3-Embedding returns
// 1024, so no vector was ever stored). Past turns are embedded in pages of
// this many messages_fts rows, so a re-index never holds the embedder long.
const EMBED_BATCH_ROWS = 16;

// A candidate whose text overlaps an already-kept result by more than this
// fraction of its own significant words is treated as a near-duplicate and
// dropped -- see mergeResults() below.
const DIVERSITY_OVERLAP_THRESHOLD = 0.7;

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

  let vectorEnabled = false;
  // { model, dims, cursor }: which embedding model turns_vec holds vectors
  // from, and the last messages_fts rowid embedded so far. null until the
  // first embedding arrives -- also for a DB from before this row existed,
  // whose vectors are of unknown origin and get rebuilt.
  let vecModel = null;
  try {
    const sqliteVec = require("sqlite-vec");
    db.loadExtension(sqliteVec.getLoadablePath());
    db.exec(`
      CREATE TABLE IF NOT EXISTS turns_vec_meta (
        rowid INTEGER PRIMARY KEY,
        sessionId TEXT,
        text TEXT,
        at TEXT
      );
      CREATE TABLE IF NOT EXISTS turns_vec_model (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        cursor INTEGER NOT NULL
      );
    `);
    vecModel = db.prepare("SELECT model, dims, cursor FROM turns_vec_model").get() || null;
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

  // Issue #263: only derived data (turns_vec, turns_vec_meta) is dropped,
  // in the same transaction that records the new model, so a crash leaves
  // either the old consistent state or the new empty one -- vectors from two
  // models are never mixed. messages_fts is never touched.
  const rebuildVectors = db.transaction((model, dims) => {
    db.exec("DROP TABLE IF EXISTS turns_vec; DELETE FROM turns_vec_meta;");
    db.exec(`CREATE VIRTUAL TABLE turns_vec USING vec0(embedding float[${dims}] distance_metric=cosine)`);
    db.prepare(
      "INSERT OR REPLACE INTO turns_vec_model (id, model, dims, cursor) VALUES (1, ?, ?, 0)",
    ).run(model, dims);
  });

  // One page's vectors and the advanced cursor commit together, so an
  // interrupted run never embeds a turn twice or skips one.
  const writeVectors = db.transaction((turns, embeddings, cursor) => {
    const insertVec = db.prepare("INSERT INTO turns_vec (embedding) VALUES (vec_f32(?))");
    const insertMeta = db.prepare(
      "INSERT INTO turns_vec_meta (rowid, sessionId, text, at) VALUES (?, ?, ?, ?)",
    );
    turns.forEach((turn, i) => {
      if (embeddings[i]?.length !== vecModel.dims) return; // stays keyword-only
      const info = insertVec.run(JSON.stringify(embeddings[i]));
      insertMeta.run(info.lastInsertRowid, turn.sessionId, turn.text, turn.at);
    });
    db.prepare("UPDATE turns_vec_model SET cursor = ? WHERE id = 1").run(cursor);
  });

  // Whole turns (not per-role -- half the embedding calls of indexTurn's
  // rows, and a search question usually spans both sides of a turn),
  // re-paired from indexTurn's consecutive user/assistant rows.
  function groupTurns(rows) {
    const turns = [];
    for (const row of rows) {
      const prev = turns[turns.length - 1];
      if (row.role === "assistant" && prev && prev.assistant === undefined &&
          prev.sessionId === row.sessionId && prev.at === row.at) {
        prev.assistant = row.text;
      } else {
        turns.push({ sessionId: row.sessionId, at: row.at, [row.role]: row.text });
      }
    }
    for (const turn of turns) {
      turn.text = `User: ${turn.user || ""}\nAssistant: ${turn.assistant || ""}`.trim();
    }
    return turns;
  }

  // Issue #263: embeds every messages_fts row past the cursor, a page at a
  // time, so a new or rebuilt table catches up on all past turns and a new
  // turn is just the last page. The model is whatever the embedder returns:
  // a different model id (retriever-index.js's embeddingModelId, #754) or
  // dimension rebuilds turns_vec and starts again from the first row. The
  // cursor commits with each page, so an interrupted run resumes where it
  // stopped. Never rejects; an unavailable embedder just ends the run
  // (keyword search is unaffected) and the next call retries. One run at a
  // time -- a call during a run returns at once, and the running loop
  // reaches the new rows anyway.
  let syncing = false;
  async function syncEmbeddings(computeEmbeddingsFn, embeddingModelIdFn = () => "") {
    if (!vectorEnabled || syncing || typeof computeEmbeddingsFn !== "function") return;
    syncing = true;
    try {
      for (;;) {
        const from = vecModel ? vecModel.cursor : 0;
        const rows = db
          .prepare("SELECT rowid, sessionId, role, text, at FROM messages_fts WHERE rowid > ? ORDER BY rowid LIMIT ?")
          .all(from, EMBED_BATCH_ROWS);
        if (!rows.length) return;
        // A full page may end between a turn's user and assistant rows --
        // that user row starts the next page instead.
        if (rows.length === EMBED_BATCH_ROWS && rows[rows.length - 1].role === "user") rows.pop();
        const turns = groupTurns(rows);
        const embeddings = await computeEmbeddingsFn(turns.map((t) => t.text));
        const dims = Array.isArray(embeddings)
          ? embeddings.find((e) => Array.isArray(e) && e.length)?.length
          : 0;
        if (!dims) return;
        const model = String(embeddingModelIdFn() || "");
        if (!vecModel || vecModel.model !== model || vecModel.dims !== dims) {
          rebuildVectors(model, dims);
          vecModel = { model, dims, cursor: 0 };
          if (from !== 0) continue; // this page was past the new cursor
        }
        const cursor = rows[rows.length - 1].rowid;
        writeVectors(turns, embeddings, cursor);
        vecModel.cursor = cursor;
      }
    } catch (e) {
      console.warn("Session embedding indexing failed:", e?.message || e);
    } finally {
      syncing = false;
    }
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
      const candidates = db
        .prepare("SELECT rowid, distance FROM turns_vec WHERE embedding MATCH vec_f32(?) ORDER BY distance LIMIT ?")
        .all(JSON.stringify(queryEmbedding), fetchCap);
      const metaLookup = db.prepare("SELECT sessionId, text, at FROM turns_vec_meta WHERE rowid = ?");
      const results = [];
      for (const row of candidates) {
        const meta = metaLookup.get(row.rowid);
        if (!meta) continue;
        if (sessionId) {
          if (Array.isArray(sessionId) && !sessionId.includes(meta.sessionId)) continue;
          if (!Array.isArray(sessionId) && meta.sessionId !== sessionId) continue;
        }
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
  // behavior is unchanged from keyword-only search. Also skipped when the
  // query was embedded by a different model (queryModel, #754's
  // embeddingModelId) or dimension than turns_vec holds (#263).
  function search({
    query,
    limit = 20,
    sort = "relevance",
    roleFilter,
    sessionId,
    queryEmbedding,
    queryModel = "",
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
      vecModel &&
      Array.isArray(queryEmbedding) &&
      queryEmbedding.length === vecModel.dims &&
      String(queryModel || "") === vecModel.model &&
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
      if (Array.isArray(sessionId)) {
        conditions.push(`sessionId IN (${sessionId.map(() => "?").join(",")})`);
        params.push(...sessionId.map(String));
      } else {
        conditions.push("sessionId = ?");
        params.push(String(sessionId));
      }
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

  // #687: the sessions with a stored message containing every typed word,
  // each as a prefix so the list narrows while typing. Words are quoted, so
  // FTS5 syntax in what was typed (quotes, AND/OR/NEAR, -, *) is just text.
  function sessionIdsMatching(text) {
    const words = String(text || "").split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
    if (!words.length) return new Set();
    const query = words.map((word) => `"${word.replace(/"/g, '""')}"*`).join(" ");
    const rows = db.prepare("SELECT DISTINCT sessionId FROM messages_fts WHERE messages_fts MATCH ?").all(query);
    return new Set(rows.map((row) => row.sessionId));
  }

  function close() {
    db.close();
  }

  // Exposed so callers (and tests) can tell whether the vector index
  // actually loaded -- e.g. sqlite-vec's platform binary being unavailable
  // in an environment (see the `catch` above) is a real, expected state,
  // not just an internal implementation detail.
  return { indexTurn, syncEmbeddings, search, sessionIdsMatching, close, vectorEnabled: () => vectorEnabled };
}

module.exports = { createSessionSearchIndex, DEFAULT_DB_PATH };
