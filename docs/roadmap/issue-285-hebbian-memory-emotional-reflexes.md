# Issue 285: Hebbian Associative Memory Graph + Emotional-State-Driven Reflexes

## Status: Piece 1 implemented (issue #295); piece 2 still scoped, not built

This doc addresses the four checklist questions the issue raised, grounded
in what's actually in the codebase today (not the source project's design)
so a future build pass starts from real constraints instead of
re-discovering them.

**Piece 1 (associative memory graph)** shipped following the round-2 design
below almost exactly, with two findings from real testing the design pass
didn't anticipate: the minimum edge weight for surfacing an associative
result needed to be 1, not 2 (a higher bar meant the common case of a pair
mentioned together only once never surfaced anything), and
`extractEntities()`'s Title-Case-run heuristic produces enough
single-word false positives from assistant replies (a sentence-initial
"Sounds" or "Agreed") that graph reinforcement filters to multi-word
entities only -- see `memory-graph.js` and `acp-memory-store.js`'s
`appendTurn`/`searchSessions`.

**Piece 2 (emotional-state reflexes)** is still scoped only, not built.

## Piece 1: Associative memory graph

### How connection-strength edges could be stored without unbounded write amplification

The codebase already has one directly analogous structure:
`acp-memory-store.js`'s `recordEntityMentions()` does a full
read-modify-write of `entity-index.json` on every `appendTurn()` call that
extracted any entities from that turn -- `loadEntityIndex()` reads the
whole file, appends a mention, and `writeJsonObject()` rewrites the whole
file back (`acp-memory-store.js:196-210`). It's capped **per-entity**
(`maxMentionsPerEntity = 100`, oldest mentions dropped via `.slice(-100)`),
but the **number of distinct entity keys** in the file has no cap at all --
a long-running install accumulates one key per unique Title-Case phrase
ever mentioned, forever.

A Hebbian edge graph is a strictly harder version of this same problem:
edges are *pairs* of memories, not single entities, so naively
strengthening every co-occurring pair on every turn is `O(n²)` in however
many memories/entities that turn touches, not `O(n)`. Applied at Mana's
actual scale (a handful of entities/facts touched per turn, not hundreds),
`O(n²)` is not the real risk -- what `recordEntityMentions()` demonstrates
is the more mundane one: **a full-file read-modify-write on the hot path
of every single turn**, which the current entity index already lives with
at flat-file scale. A graph structure makes that read-modify-write heavier
per turn (updating many edges, not appending to one list) and adds the
unbounded-key-count problem entity-index.json already has, without ever
having pruned it.

**Recommendation if this gets built:** cap total edge count (not just
per-node degree) the same deliberate way `maxFacts`/`maxMentionsPerEntity`
already cap the two existing memory-adjacent structures in this file
(`acp-memory-store.js:149-153`), and batch edge-strength updates instead
of rewriting a graph file synchronously inside `appendTurn()`'s hot path --
`appendTurn()` already has a fire-and-forget pattern for exactly this kind
of non-blocking side work (its summarization trigger, and issue #263's
embedding indexing, both run as detached async work rather than blocking
the turn append itself).

### Whether spreading-activation retrieval is a third signal in `session-search-index.js`'s `search()`, or a separate subsystem

Having now read `search()` in full (`session-search-index.js:214-266`):
it already blends two ranked signals (FTS5 keyword `rank`, vec0 cosine
`distance`) via `mergeResults()` -- interleave-by-rank, then drop
near-duplicates by token overlap (`DIVERSITY_OVERLAP_THRESHOLD = 0.7`).
Structurally, a spreading-activation score is a *third* rankable signal
with the same shape (a query -> a scored list of candidate turns), so it
composes into `mergeResults()`'s existing interleave-and-dedup pattern
without redesigning it -- add a `graphResults` array and interleave three
lists instead of two.

But there's a real semantic mismatch worth flagging: FTS5 and vec0 both
score **this specific query** against **turn text**. Spreading activation
scores **a memory already surfaced this turn** against **other memories
connected to it in the graph** -- it needs a starting point (an
already-activated node) that keyword/vector search doesn't require. That
makes it more naturally a **second retrieval pass** chained after the
existing hybrid search (take today's top keyword+vector hits, spread
activation outward from them, merge the result) rather than a third
parallel signal computed from the same query string. Whether that's "the
same subsystem" or "a separate one" is somewhat a labeling question; the
important finding is that it needs the first pass's *output* as input, not
just the same query as input.

## Piece 2: Emotional-state-driven reflexes

### What the emotional-state vector's inputs would actually be, and its scope (per-session vs. persistent)

**There is currently no persistent emotional-state tracking anywhere in
this codebase.** The only existing "emotion" logic is
`windows-launcher/renderer/reply-emotion.js`'s `detectReplyEmotion()` --
and it is a fundamentally different kind of thing than what this issue
asks for:

- **Stateless, not persistent.** It's a pure function of one reply's text
  (emoji/kaomoji pattern match, then a small English keyword list),
  called fresh for each reply with no memory of prior calls.
- **Single discrete label, not a weighted vector.** It returns one of
  `excited | sad | angry | disgusted | talking` -- a single enum value,
  not multiple weighted emotion scores.
- **Drives the avatar's expression for *that reply*, not background
  behavior.** Its only consumer is picking a Live2D/VRM expression state.
  It has no connection to `server.js`'s idle-triggered background jobs at
  all.

So piece 2 is genuinely new infrastructure, not an extension of something
that already tracks state. The real design question the issue poses
(sentiment analysis per turn vs. explicit model self-report vs. something
else) is a judgment call this pass can't resolve without deciding whether
Mana's *own* emotional state (something she'd need to self-report or infer
about herself) or a read on the *user's* affect (inferable from their
messages via sentiment analysis) is what's actually being modeled -- the
issue's "loneliness" example reads as the former, which has no existing
per-turn signal to derive it from (reply-emotion.js only labels the
model's own reply's tone, not an internal state). Whichever direction is
chosen, per-session vs. persistent has an existing precedent to follow:
`acp-memory-store.js`'s summary/facts are already persistent
(cross-session, disk-backed), so a persistent emotional-state vector would
naturally live alongside them rather than as new session-scoped state.

### Whether reflex-triggered behaviors reuse the existing idle-triggered machinery or need their own trigger path

The existing idle trigger, read in full, is a single fixed clock threshold:
windows-launcher's `powerMonitor` poll reports elapsed idle seconds to
`POST /internal/idle-report` (`server.js:1665`), compared against one
env-configured threshold (`MANA_IDLE_THRESHOLD_MS`, default 20 minutes),
firing `triggerIdleConsolidation()` once per idle period
(`idleConsolidationFiredForCurrentIdlePeriod` latches until activity
resumes, `server.js:1595,1670-1687`). `triggerIdleConsolidation()` itself
is already a **composed batch** of several independent passes (background
compactor, reviewer, connections pass, skill proposal, skill pruning --
`server.js:1597-1659`), each wrapped in its own try/catch so one failing
pass never blocks the others.

A state-based reflex trigger (fire when an emotional score crosses a
threshold, not when a clock does) is a **different trigger condition**,
not a different job-running mechanism -- it would call the same kind of
already-existing "run this background pass" functions
(`runBackgroundCompactorPublic`, or a new `runJournalEntryPass`-shaped
function following the same pattern), just from a different `if` check
than `idleSeconds >= thresholdSeconds`. The genuinely open design question
is where that check lives: piggybacking on the existing
`/internal/idle-report` handler (checking emotional state alongside the
idle timer on the same poll) versus a wholly separate trigger path is a
real architectural choice, but *either* answer reuses
`triggerIdleConsolidation`'s existing batch-of-independent-passes pattern
for what actually runs once triggered.

## Recommendation

Both pieces are still genuinely investigate-only, not ready to scope into
an implementation task in the same pass as this doc -- consistent with the
issue's own framing. The concrete blockers, in priority order:

1. **Piece 2 needs a source-of-truth decision first**: what specifically
   produces Mana's emotional-state score, and whether it models her state
   or the user's. Nothing in this pass can resolve that without a product
   decision.
2. **Piece 1's edge-storage design** (batched, capped writes, chosen
   independently of piece 2) is more mechanical and could reasonably be
   scoped into its own implementation doc without waiting on piece 2 --
   the issue's own note that the two pieces "could end up being separately
   scoped" looks right after this investigation, not just a hedge.

## Out of scope for this doc

No code changes. No decision made on the open questions above -- this doc
narrows them to concrete, codebase-grounded choices rather than resolving
them, per the issue's own "not scheduled" framing.
