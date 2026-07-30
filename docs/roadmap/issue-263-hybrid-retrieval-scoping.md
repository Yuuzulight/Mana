# Issue 263: hybrid keyword+vector retrieval + cursor resummarization -- scoping

## Status: scoped and de-risked, not implemented this pass

This issue has three parts. Part 3 (this doc) and enough investigation to make
part 1 concrete are done here; parts 1 and 2 themselves are deliberately not
implemented in this pass -- both touch code that runs on every single chat
turn (`acp-memory-store.js`'s `appendTurn`), and landing them without the
runway for real regression testing against that path is a worse outcome than
scoping them properly and picking them up with room to verify.

## Part 3: the storage-scale decision, answered directly

**SQLite remains sufficient at Mana's actual scale, and the path to add
vector search to it (if ever needed) is now concretely known, not just
assumed.** Two prior investigations already did the real legwork:

- `docs/roadmap/issue-220-cache-ram-and-sqlite-vec-eval.md`: verified
  `sqlite-vec` loads into Node 22's built-in `node:sqlite` (`DatabaseSync` +
  `loadExtension()`) with **zero native compilation** -- the originally
  assumed `better-sqlite3` pairing fails to install on this dev machine
  (no Visual Studio C++ toolchain), but `node:sqlite` sidesteps that
  entirely. Benchmarked against the current JS brute-force cosine loop in
  `tools/vector-store.js`: **no meaningful performance difference at
  Mana's actual 2,000-entry scale** (both sub-3ms); sqlite-vec's ~2x edge
  only shows up around 50,000 entries, well beyond any current cap.
- `docs/roadmap/issue-195-tei-embedder-eval.md`: confirmed the existing
  local embedder (`tools/local_embedder.py`, spawned by
  `windows-launcher/main.js` on port 9001) stays as-is (TEI has no clean
  Windows install path), and fixed a real wire-format gap in
  `tools/retriever-index.js`'s `computeEmbeddings()` so it already accepts
  either response shape.

**Conclusion**: no Postgres/pgvector, no new service. If/when hybrid search
is implemented (part 1 below), it should use the already-verified
`node:sqlite` + `sqlite-vec` pairing, not a new database.

## Part 1: hybrid keyword+vector search -- concrete plan, not yet built

### What exists today (verified by reading the real code, not assumed)

- `node-bot/session-search-index.js`: SQLite FTS5 full-text index over every
  raw turn, exact/keyword match only. This is what part 1 extends.
- `node-bot/tools/retriever-index.js`'s `computeEmbeddings()`: already
  calls the local embedder for the **file/document retriever** path (Deep
  Research sources, coding-mode repo context) -- a real, working embedding
  pipeline exists, it's just not wired to session search.
- `node-bot/tools/vector-store.js`'s `makeFallbackStore`: a JS brute-force
  cosine-similarity search over that same file-retriever's vectors --
  proof the embedding + search shape already works end-to-end for a
  different corpus.

### The actual gap

Session turns (`acp-memory-store.js`'s `appendTurn`, indexed into
`session-search-index.js` via `indexTurn`) never get an embedding computed
or stored -- only FTS5 tokenizes them. Closing this is "wire an existing
pipeline to a second corpus," not "build embeddings from scratch."

### Concrete implementation shape (for whoever picks this up)

1. **Storage**: add a `vec0` virtual table (via `sqlite-vec`, loaded through
   `node:sqlite`'s `loadExtension()`, matching issue #220's verified
   pairing) alongside the existing FTS5 table in
   `session-search-index.js`'s own SQLite database file -- not a separate
   database, per this issue's own scope.
2. **Write path**: in `appendTurn` (or `indexTurn`), after the existing
   FTS5 `indexTurn` call, also compute an embedding for the turn text via
   the same `computeEmbeddings()`-shaped call `retriever-index.js` already
   uses, and insert it into the vec0 table keyed by the same turn id FTS5
   uses. Must be async/best-effort, same "never let indexing failure break
   the actual conversation flow" guarantee `appendTurn` already gives FTS5
   indexing (see the `try/catch` around `sessionSearchIndex.indexTurn`).
3. **Read path**: `session-search-index.js`'s `search()` runs the FTS5
   query as today, plus a `vec0` similarity query against the same
   question's embedding; merge the two ranked lists (a simple approach:
   normalize each list's scores to [0,1], take a weighted sum, e.g.
   `0.5*ftsScore + 0.5*vecScore` -- tune once real usage data exists, not
   guessed here) and **rerank for diversity** (e.g. skip a result whose
   text is near-duplicate of one already kept, by simple token-overlap
   check -- avoids returning three near-identical turns just because they
   all score high on both signals).
4. **Backfill**: existing sessions have no stored embeddings. Either
   backfill lazily (compute+store on first search miss) or via a one-time
   migration script -- not designed further here since it depends on
   whether backfill-on-read or a batch job fits better once this is
   actually being built.
5. **Tests**: `session-search-index.test.js` already exists and covers
   FTS5 behavior with a real (temp-dir) SQLite database -- extend the same
   pattern with real (small, deterministic) embedding vectors, not a
   live embedder call, matching how `retriever-embeddings-*.test.js`
   already test the file-retriever's embedding path.

### Why not implemented now

This is a write-path change to the single most heavily-exercised piece of
Mana's memory system (every chat turn calls `appendTurn`), plus a new
runtime dependency (`node:sqlite`, still explicitly experimental in Node
22, with no `engines` field in `node-bot/package.json` pinning a minimum
version yet). Both are real, tractable pieces of work -- the investigation
above is what makes them tractable -- but they deserve a dedicated pass
with room for real regression testing against live conversation flow, not
a rushed addition at the tail end of an unrelated batch of fixes.

## Part 2: cursor-based re-summarization -- concrete plan, not yet built

### Current mechanism (verified against `acp-memory-store.js`)

- `appendTurn` appends a fresh one-line summary of each new turn onto the
  session's rolling `summary` string immediately (cheap, already
  incremental at the per-turn level).
- When that rolling summary's estimated token count crosses ~90% of
  `maxSummaryTokens`, an async **full recompaction** fires: the *entire*
  accumulated summary string is re-summarized in one `summarizeFn` call.
  This is the "threshold-triggered full re-compact" the issue means --
  not the per-turn append (which is already incremental), the periodic
  full-summary rewrite.
- Separately, `server.js`'s background reviewer (`BACKGROUND_MEMORY_META`)
  tracks **file-level** mtime per session file to skip re-processing an
  unchanged session -- a coarser, different mechanism than a per-session
  turn cursor, and not what this issue is asking to change.

### Concrete implementation shape

1. Add a `lastSummarizedTurnIndex` (or timestamp) field to the persisted
   session object, defaulting to 0/null for existing sessions (no
   migration needed -- absence just means "resummarize from the start").
2. When the recompaction threshold fires, pass `summarizeFn` only the
   turns *after* that cursor (plus the existing rolling summary as context
   to fold new material into, not discard) instead of re-deriving from the
   full accumulated summary string alone.
3. Advance the cursor to the current turn count on successful compaction,
   same place `session.summary` is already updated after a successful
   `summarizeFn` call.
4. This is a genuinely small, self-contained change (one new field, one
   slice of `session.turns` at the existing call site) -- the reason it's
   deferred alongside part 1 rather than implemented here is purely
   time/scope discipline for this pass, not technical difficulty. Whoever
   picks this up next should be able to land it in isolation without
   needing part 1 at all.

## Out of scope (unchanged from the original issue)

No external memory service, no Postgres/pgvector. No change to the
existing `facts.json` cap or `entity-index.json` regex tagging.
