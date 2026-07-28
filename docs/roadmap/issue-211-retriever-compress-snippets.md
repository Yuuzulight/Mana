# Issue 211: Compress retriever-index.js Search Snippets

## Goal

Follow-up from issue #208, which compressed Deep Research's excerpts but
deliberately scoped `tools/retriever-index.js`'s search snippets out. This
issue does that follow-up: `search()`'s three branches each flat-truncated
a result's raw file text to 800 chars regardless of what was actually
relevant to the query.

## Status: Implemented (`tools/retriever-index.js`, wired into the coding-mode repo-retrieval block in `server.js`)

## Design

- **`buildSnippets(tops, query, compress)`** -- new shared helper.
  `search()`'s three branches (tf-fallback, embedding-cosine-similarity,
  embedding-query-failed-fallback-to-tf) each did the identical
  read-file-then-`slice(0, 800)` work, just from a different score
  source; that duplication is now one function all three call.
- Reuses `deep-research.js`'s existing `buildCompressPrompt`/
  `parseCompressedExcerpts` (issue #208) rather than inventing a parallel
  prompt/parse shape -- `retriever-index.js` requires `deep-research.js`
  (no circular dependency; `deep-research.js` doesn't touch
  `retriever-index.js`).
- **One batched compress call per `search()` call, not one per result** --
  same cost-consciousness #208 established.
- **Never breaks a search.** No `compress` supplied, a response that
  doesn't cover every result, the compress call itself throwing, or every
  file failing to read (skips the compress call entirely -- nothing worth
  compressing) all fall back to the flat-truncated snippet.
- **Wired at the one real model-facing consumer**: the coding-mode
  repo-retrieval block in `server.js` (`MANA_RETRIEVAL_MODES`-gated,
  concatenates snippets into a `--- Retrieved snippet N ---` block
  injected into the reply prompt). A new shared `compressExcerpts(prompt)`
  function factors out the `runLocalLlamaReply(..., COMPRESS_SYSTEM_PROMPT)`
  call that issue #208's Deep Research wiring already used inline --
  both call sites now share the same function instead of duplicating the
  lambda.

## Deliberate simplifications (matches #208's own scoping judgment)

- **`retriever-admin-capability.js`'s `/admin/retriever/search` debug
  route is untouched.** A human debugging what got indexed wants the raw
  ground-truth snippet, not a query-shaped summary -- compressing there
  would work against the route's actual purpose.
- **The separate inline vector-store-direct snippet-truncation** (in both
  `server.js`'s coding-mode block, lines ~3300-3324, and the admin route)
  is a different, smaller, parallel code path -- not `retriever-index.js`'s
  own `search()` -- and out of scope for this issue.

## Verified

- `node-bot/test/retriever-index-compress.test.js` (6 new tests, against
  real temp files): flat-truncation fallback with no `compress`, read
  failures, one-batched-call behavior, a result not covered by the
  response keeping its flat-truncated snippet, resilience when `compress`
  throws, and skipping the compress call entirely when nothing was
  readable.
- Full `node-bot` suite (one process per file): no regressions.
