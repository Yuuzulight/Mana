# Issue 217: Dedupe/Compress the Vector-Store-Direct Snippet Path

## Goal

Follow-up from #211/#208. #211 added compression to `retriever-index.js`'s
`search()`, wired into the coding-mode repo-retrieval block in `server.js`.
But that block has two ways to get hits, and only one of them went through
`search()` -- a vector-store-direct fast path returned early with its own
hand-rolled read-file-then-`slice(0, 800)` loop whenever a vector store had
entries, meaning #211's compression had zero effect in the case it's most
likely to actually hit (any setup with a built vector store).

## Status: Implemented

## Design

- **`server.js`'s coding-mode retrieval block**: the vector-store-direct
  branch now maps its raw hits (`{id, path, score}`) and calls
  `retrieverIndex.buildSnippets(candidates, transcript, compressExcerpts)`
  -- the exact shared helper #211 already built and exported -- instead of
  its own inline loop. This closes the gap: whichever path actually
  produces hits (vector-store-direct or the `search()` fallback), both now
  go through the same compression logic.
- **`retriever-admin-capability.js`'s `/admin/retriever/search` route**:
  same dedupe, but called with `compress: null` -- this route intentionally
  stays raw ground truth (per #211's own reasoning: a human debugging the
  index wants to see exactly what's stored, not a query-shaped summary),
  so this is a pure duplication removal, not a new compression surface.

## Deliberate simplifications

- **No new direct test harness for `server.js`'s coding-mode retrieval
  block.** It's deeply nested inside `buildAssistantReply` with zero
  pre-existing test coverage (a gap that predates this issue, not
  introduced by it). Verified instead via careful code review, `node
  --check`, and the full regression suite; `retriever-admin.test.js`'s
  updated/new tests already exercise `buildSnippets` against the identical
  vector-store hit shape (`{id, path, score}`) both call sites now share,
  giving equivalent confidence in the actual behavior that changed.

## Out of scope

Adding compression to the admin debug route -- deliberately kept raw, per
#211.

## Verified

- `node-bot/test/retriever-admin.test.js`: updated the existing
  vector-backed-search test's mock to include `buildSnippets` (now
  actually called instead of silently falling through to the `search()`
  fallback due to a missing mock method), tightened its assertions to
  check `vectorStore: true` and the real snippet content, and added a new
  dedicated test asserting `buildSnippets` is called with the correctly
  mapped candidate shape and `compress: null` specifically (never
  compressed, on purpose).
- Full `node-bot` suite (one process per file): no regressions.
