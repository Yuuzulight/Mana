# Issue 263: hybrid keyword+vector retrieval + cursor resummarization -- scoping

## Status: both parts implemented

**Part 1 (hybrid keyword+vector search) and part 2 (cursor-based
re-summarization) are both now implemented** -- see their sections below for
what shipped.

Part 1 was originally deferred twice on the belief that it needed
`node:sqlite` (still Stability-1 experimental) instead of `better-sqlite3`,
because issue #220's investigation found `better-sqlite3` "fails to install
on this dev machine (no Visual Studio C++ toolchain)". That premise turned
out to be stale by the time this was picked back up: `session-search-index.js`
(built for issue #260, the day *after* #220's investigation) already depends
on `better-sqlite3` directly and works fine -- `better-sqlite3@11.10.0` ships
prebuilt binaries for Node's ABI, sidestepping the toolchain issue entirely,
which #220's investigation (against a different version) didn't hit. Part 1
was re-scoped and built on the already-shipped `better-sqlite3` connection
instead of introducing `node:sqlite`, which turned out to be a smaller change
than the original plan (one SQLite driver in this file, not two).

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

**Conclusion**: no Postgres/pgvector, no new service. Part 1 uses SQLite (via
the already-shipped `better-sqlite3`, see the corrected note above), not a
new database.

## Part 1: hybrid keyword+vector search -- implemented

`session-search-index.js` now loads `sqlite-vec`'s extension into its
existing `better-sqlite3` connection and creates a `turns_vec` (`vec0`)
table plus a plain `turns_vec_meta` table (sessionId/text/at, keyed by the
same rowid) alongside the existing FTS5 `messages_fts` table -- one
database file, one driver, matching this issue's own scope.

- **Write path**: `acp-memory-store.js`'s `appendTurn` fires a
  fire-and-forget async block (mirroring the compaction IIFE part 2 added)
  that computes one embedding for the whole turn (`User: ...\nAssistant:
  ...`, not per-role -- half the embedding calls of FTS5's per-role rows)
  via an injected `computeEmbeddingsFn` (same shape as
  `retriever-index.js`'s `computeEmbeddings`), then calls the new
  `sessionSearchIndex.indexEmbedding()`. Never awaited by `appendTurn`, so a
  slow/unavailable embedder can't add latency to the reply path, and any
  failure just means that turn stays keyword-searchable only.
- **Read path**: `acpMemoryStore.searchSessions()` computes a query
  embedding the same way before calling `sessionSearchIndex.search()`.
  `search()` blends the FTS5 keyword results with a `vec0` KNN query only
  when a valid `queryEmbedding` is present, sort is the default
  `"relevance"`, and no `roleFilter` was given (vector hits are whole-turn,
  not per-role, so they can't honestly satisfy a role filter) -- otherwise
  behavior is byte-for-byte the same as before this issue. The two ranked
  lists are interleaved (best-first from each) and reranked for diversity:
  a candidate whose text overlaps an already-kept result by more than 70%
  of its own significant words (same token-overlap technique
  `acp-memory-store.js`'s conflict detection already uses) is dropped, so a
  semantic hit that just restates a keyword hit doesn't eat a results slot.
- **Everything stays additive by construction**: `USE_EMBEDDINGS` is off by
  default, so with no embedder configured, `computeEmbeddingsFn` returns
  `null` embeddings and every search silently stays keyword-only -- zero
  behavior change for anyone not opted in. If `sqlite-vec`'s extension
  fails to load on some platform, `vectorEnabled` stays `false` and FTS5
  search is completely unaffected.
- **Backfill**: not implemented -- existing sessions get embeddings
  indexed only for turns appended *after* this change (same "compute going
  forward, don't migrate the past" choice the original scoping left open,
  now resolved by not building it: at Mana's actual scale, backfill wasn't
  worth the extra machinery for a first cut).
- **Tests**: `session-search-index.test.js` -- 7 new tests (semantic match
  with zero keyword overlap, hybrid-skip for `newest`/`oldest` sort and an
  explicit `roleFilter`, session-scoped vector search correctness,
  diversity dedup, dimension-mismatch handling on both the query and index
  side, and no-op safety on missing fields) using `embedDim: 4` for fast
  deterministic vectors. `acp-memory-store.test.js` -- 4 new tests covering
  the write-path/read-path wiring specifically (the merge/diversity logic
  itself is tested where it lives, in `session-search-index.test.js`).

While building this, found and fixed a real (if narrow) pre-existing gap in
`retriever-index.js`: two of its "skip real work under test" guards
(`buildIndex`, `incrementalScan`) were missing the `NODE_TEST_CONTEXT`
fallback the rest of this codebase's equivalent guards use -- only matters
when `USE_EMBEDDINGS=1` is explicitly set (off by default) and a test file
runs outside `run_tests.js`. Fixed both. `computeEmbeddings()`'s own guard
was deliberately left `NODE_ENV`-only: `retriever-embeddings-*.test.js`
clears `NODE_ENV` specifically to exercise the real HTTP-calling logic
against a fake server, and a `NODE_TEST_CONTEXT` fallback there would defeat
that (confirmed by trying it -- broke 3 subtests, reverted).

Also found and fixed a real packaging gap while installing `sqlite-vec`:
its platform binary (`sqlite-vec-windows-x64`) is declared as an
`optionalDependency`, which `node-bot/.npmrc`'s `omit=optional` (a
deliberate issue #187 setting, to keep a vulnerable native-build optional
peer out) silently skips on every `npm ci`/`npm install` -- including in
CI. Listed `sqlite-vec-windows-x64` as a direct dependency in
`node-bot/package.json` instead, verified with a genuine clean
`rm -rf node_modules && npm ci` that it now installs and the extension
loads correctly.

## Part 2: cursor-based re-summarization -- implemented

Shipped: a `lastSummarizedTurnIndex` field on the persisted session object,
advanced to the current turn count on every successful compaction. Each
compaction now only re-summarizes turns added since that cursor (bounded by
`maxRecentTurns`), rather than always re-deriving from a fixed last-10-turn
window regardless of what had already been compacted.

While implementing this, also found and fixed a pre-existing bug in the
rolling `summary` field's truncation direction: `cleanText`'s
`.slice(0, maxLength)` keeps the start of a string, which is correct for a
single too-long turn but wrong for `summary` specifically, since new content
is always appended at the end -- once the accumulated string exceeded
`maxSummaryChars`, the old truncation silently dropped the just-added newest
content and kept stale early material instead. Added `truncateKeepingRecent`
(keeps the tail) and used it only for the `summary` field.

Tests: `node-bot/test/acp-memory-store.test.js` -- 3 new tests covering cursor
advancement, cursor-scoped (not fixed-window) re-summarization on a second
compaction, and the truncation-direction fix. Full `node-bot` suite verified
green after the change (all files pass via `run_tests.js`).

### Current mechanism (verified against `acp-memory-store.js`, pre-fix baseline)

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
