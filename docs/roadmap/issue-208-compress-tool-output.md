# Issue 208: Compress Tool-Output Excerpts Instead of Flat Char-Truncation

## Goal

Follow-up from issue #200's context-compression review: neither
`tools/retriever-index.js`'s search snippets nor `tools/deep-research.js`'s
per-source read excerpts were ever summarized -- both were flat
character-truncated regardless of what part of the source was actually
relevant to the question.

## Status: Implemented for Deep Research (`tools/deep-research.js`)

Scoped to Deep Research only, not `retriever-index.js` -- see "Deliberate
simplifications" below.

## Design

- **`options.compress`** -- a new optional injected dependency on
  `runDeepResearch`, same `(prompt) => Promise<string>` shape as the
  existing `decompose`/`reflect`/`synthesize` dependencies. This module
  stays unaware of which LLM/profile actually condenses excerpts.
- **One batched call per cycle, not one call per source** -- per the
  issue's own explicit ask. `searchAndRead`'s existing per-cycle closure
  (issue #197) already reads a whole batch of newly-pooled sources
  together; the compress step runs once per that batch via
  `buildCompressPrompt(question, addedSourcesThisCycle)`, listing every
  source in one prompt (`[N] title/URL/excerpt` blocks, same numbering
  style `buildResearchPrompt` already uses), and parses the reply's
  `[N] condensed excerpt` blocks back with `parseCompressedExcerpts` into a
  `Map<index, text>`.
- **Reuses the existing `summarizeFn`-style LLM-call pattern** (issue
  #141) rather than inventing a new one -- wired in `server.js` exactly
  like `decompose`/`reflect` already are: `compress: deps.compress ||
  ((prompt) => runLocalLlamaReply(prompt, 1200, "quality",
  COMPRESS_SYSTEM_PROMPT))`.
- **Never sinks the research pass.** A missing `options.compress`, a
  parse that doesn't cover every source, or the compress call itself
  throwing all fall back to the source's original (flat-truncated)
  excerpt -- same "degrade, don't break" resilience philosophy
  `decompose`/`reflect` already established.

## Deliberate simplifications

- **`retriever-index.js`'s snippets are out of scope for this pass.**
  Deep Research's excerpts are the concrete case #200 measured against
  `llama-server`'s real 4096-token context window (up to ~4000 tokens of
  excerpt from 8 sources alone); the retriever's 800-char snippets are a
  much smaller, separate surface (document-reader ingestion, issue #126)
  serving a different purpose (keyword/semantic search results shown
  toward the user, not folded into one synthesis prompt). Compressing it
  too is real future work if it turns out to matter, not bundled in here
  to keep this change scoped to the case that actually motivated it.
- **No new request/env toggle to disable compression.** `compress` is
  wired unconditionally in `server.js`, matching how `decompose`/`reflect`
  are already always wired (the actual "opt-in" is `options.compress`
  simply being absent for callers/tests that don't provide it, same as
  the other two). The issue's cost concern ("should not add a full extra
  LLM round-trip per source") is addressed structurally -- one batched
  call per cycle, never N -- rather than with a separate on/off switch.

## Out of scope

`retriever-index.js` snippet compression (see above) and any UI to
preview/adjust condensed excerpts before synthesis -- both real, separate
future work if needed.

## Verified

- `node-bot/test/deep-research.test.js` (+8 tests): `buildCompressPrompt`/
  `parseCompressedExcerpts` unit tests, one-batched-call-not-N behavior,
  compressed excerpts flowing into the synthesis prompt, a source not
  covered by the response keeping its original excerpt, and resilience
  when `compress` itself throws.
- `node-bot/test/deep-research-capability.test.js` (+1 test): `compress`
  is forwarded from capability context into `runDeepResearch`'s options.
- Full `node-bot` suite (one process per file): no regressions.
