# Issue 260: Honcho (dialectic user modeling) vs. Mana's current memory design

## Status: Investigated, not adopted -- recommendation is "don't," with a named condition for revisiting

Found while researching alternative memory-provider designs for issue
#260's other three items (session search, memory-write approval,
background review model profile). Honcho (plastic-labs/honcho, open
source, self-hostable) is a pluggable "dialectic" memory provider some
other agent projects support -- this is a genuinely different idea from
anything Mana does, so it gets its own comparison rather than a quick
port.

## Mana's current approach (verified against real code, not assumed)

- `acp-memory-store.js`: one JSON file per session holding the full raw
  `turns` array, plus a rolling `summary` string an LLM pass periodically
  re-compacts once it grows past a token budget (`summarizeFn`).
- `entity-index.json`: zero-LLM-call regex Title-Case entity tagging across
  sessions.
- `facts.json`: explicit remembered facts via the `memory__remember` tool
  (issue #198) -- the model asserts "key: text" pairs directly, capped at
  500.
- `buildPromptMemory`/`getRelatedFacts`: at reply time, assembles a bounded
  prompt block from the summary + related facts + entity mentions,
  truncated to fit the token budget.
- New as of issue #260: SQLite FTS5 full-text index over every turn's raw
  text (`session-search-index.js`), independent of the summary above --
  searchable via a `session_search` tool.

All of this is plain JSON/text on disk -- inspectable, hand-editable, fully
local, zero external service or account.

## Honcho's approach (from its own docs -- not independently verified against Honcho itself)

A separate service (self-hostable or hosted at app.honcho.dev) that ingests
raw conversation turns and builds a "theory of mind" model of the user via
a "dialectic" API: you ask it a natural-language question about the user
("what does this person care about in their work") and it synthesizes an
answer from the *entire* conversation corpus using its own internal
representations -- not from pre-written facts or a fixed summary. Some other
agent projects treat it as one of several swappable memory backends, not a
single fixed design.

## Pros of Honcho over Mana's current approach

1. Doesn't require deciding upfront what's "worth remembering." A dialectic
   query can synthesize an answer to a question nobody anticipated asking,
   drawn from the full raw history -- Mana's fact/summary system is limited
   to whatever got explicitly captured at write time.
2. Scales better for a very long-lived relationship. Mana's `summary`
   string and `facts.json` are both explicitly bounded/compacted by
   design -- detail is *lost* over time on purpose, to keep the prompt
   memory block cheap. A good dialectic model over the full raw corpus
   doesn't have that same forced forgetting.
3. Offloads the "what matters" judgment to Honcho's own algorithm, instead
   of Mana's LLM having to decide what's worth an explicit `remember` call
   or hoping idle consolidation caught it.

## Cons of Honcho relative to Mana's current approach

1. **Opacity.** Mana's memory is fully readable/editable JSON today -- a
   user (or Mana's own debugging) can open `facts.json` and see exactly
   what's remembered and why. A dialectic answer is LLM-synthesized on
   demand; there's no equivalent "just read the memory," only "ask it a
   question and trust the answer," with a much thinner audit trail.
2. **A new moving part.** Even self-hosted, it's a separate service/database
   to run and keep alive alongside `node-bot`, versus staying in-process
   with tooling Mana already has (Node, SQLite). Mana's own stated design
   philosophy (README: "everything runs on your own Windows PC... it works
   offline") leans hard into minimal moving parts -- this cuts against that
   more than it would for an agent that already embraces a much larger,
   more distributed architecture (multiple backends, cron, a gateway
   process, etc.) as a baseline.
3. **Redundant with what issue #260 already ships.** The concrete gap that
   would have motivated reaching for Honcho -- "can't search raw history,
   only curated summaries" -- is now directly addressed by the FTS5 session
   search shipped in the same issue, using existing local tooling. That
   specific pain point no longer needs an external system.
4. **Unclear fit with Mana's default local model.** Honcho's dialectic
   reasoning presumably wants a reasonably capable model to synthesize good
   answers over raw context. Mana's default local brain is a small Qwen
   model (0.5B-8B, chosen for a modest home PC); it's untested whether
   Honcho's approach holds up as well against that as against whatever
   larger models a typical agent deployment would wire up via a cloud API.

## Recommendation: don't adopt Honcho

Mana's current design (explicit files + entity tagging + remembered facts
+ FTS5 search) already covers the concrete gap Honcho would have filled,
with less operational complexity and full alignment with Mana's
local-first, inspectable-by-design philosophy.

**The condition for revisiting**: Honcho's real remaining advantage over
FTS5 is semantic/fuzzy recall -- answering "what did we talk about
regarding my career" when the actual conversation never used those exact
words. FTS5 is keyword/exact-match search; it won't catch that. If keyword
search turns out insufficient in practice for real "what did we talk
about" questions, the better next step is probably **local embedding-based
semantic search** layered onto the existing raw-turn store -- issue #195
already evaluated TEI as a local embedder backend, so that infrastructure
investigation is already done -- rather than adopting an entirely separate
external memory service just to get semantic recall.
