# Issue 285: Hebbian Associative Memory Graph + Emotional-State-Driven Reflexes

## Status: Scoped, not implemented (per the issue's own "investigate-only" framing)

This doc addresses the four checklist questions the issue raised, grounded
in what's actually in the codebase today (not the source project's design)
so a future build pass starts from real constraints instead of
re-discovering them. No code changed as part of this pass.

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

## Round 2: deeper technical scoping

The round-1 pass above narrowed both pieces to concrete, codebase-grounded
questions but stopped short of an actual design. This round answers those
questions directly -- piece 1 needed no product decision to go deeper;
piece 2 needed one, and got it: **track both** Mana's own inferred state
and a read on the user's affect, as two separate values, rather than
conflating them into one vector.

### Piece 1: Hebbian graph -- storage, schema, and wiring

**Storage: SQLite, not a JSON file.** Round 1 already established
`recordEntityMentions()`'s full-file read-modify-write as the write-
amplification risk to avoid. A graph's edges get reinforced far more often
per turn than `entity-index.json`'s per-entity mention lists do (every
pairwise combination of a turn's entities, not one append per entity), so
JSON's full-rewrite cost is a *worse* fit here than it already is for that
file. `session-search-index.js` already established the precedent for
reaching for `better-sqlite3` (not a new dependency) when data needs
frequent, indexed, atomic updates rather than whole-file rewrites --
reused here, not a new pattern.

```sql
CREATE TABLE memory_graph_edges (
  node_a TEXT NOT NULL,
  node_b TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  last_reinforced_at TEXT NOT NULL,
  PRIMARY KEY (node_a, node_b)
);
CREATE INDEX idx_memory_graph_edges_node_a ON memory_graph_edges(node_a);
CREATE INDEX idx_memory_graph_edges_node_b ON memory_graph_edges(node_b);
```

`node_a`/`node_b` are the same lowercased entity keys `entity-index.json`
already uses (`entity.toLowerCase()`), with `node_a < node_b` enforced at
write time so each unordered pair has exactly one row. Reinforcement is one
atomic upsert (`INSERT ... ON CONFLICT(node_a, node_b) DO UPDATE SET
weight = weight + 1, last_reinforced_at = ?`) -- no read-then-write race,
unlike `entity-index.json`'s load-whole-file-then-save pattern.

**What counts as co-occurrence, and where it's computed:** the entities
`extractEntities()` already pulls from a turn's text for
`recordEntityMentions()` -- every pairwise combination among that same
list reinforces an edge, computed in the same call, not a second
extraction pass. Zero new NLP.

**Caps:** `maxEdges` (e.g. 5000 -- an order of magnitude above `maxFacts`'s
500 since edges are pairs, not single facts), pruned periodically (see the
trigger-reuse note below) by deleting the lowest-weight rows past the cap.
`maxDegree` per node (e.g. 50) stops one hub entity (Mana herself, likely
mentioned in nearly every turn) from accumulating an edge to everything --
reinforcing a pair where one side is already at `maxDegree` evicts that
node's own weakest existing edge first rather than growing further.

**Batching:** never synchronous inside `appendTurn()`'s hot path. Precedent
already in this file: `appendTurn()`'s embedding indexing (issue #263)
fires-and-forgets via an unawaited async call. Same pattern for edge
reinforcement -- WAL mode (already enabled by `session-search-index.js`)
makes a single-row upsert cheap enough that "batching" mainly means
"off the critical path," not a separate flush queue.

**Module boundary:** a new sibling module, `memory-graph.js`, mirroring
`session-search-index.js`'s shape (`createMemoryGraph({dbPath})` returning
`{reinforce(entities), getNeighbors(nodeKey, {minWeight, limit}), close}`),
optionally injected into `acp-memory-store.js`'s `appendTurn()` exactly
like `sessionSearchIndex`/`computeEmbeddingsFn` already are.

**Retrieval wiring, made concrete:** after `session-search-index.js`'s
`search()` returns its top-K keyword+vector hits, extract entities from
those hit texts (same `extractEntities()` call), look up 1-hop neighbors
above a weight threshold via `getNeighbors()`, and any neighbor with
mentions in `entity-index.json` becomes a candidate result tagged
`matchType: "associative"` -- appended to the merged list, subject to the
same diversity-dedup `mergeResults()` already applies to keyword/semantic
hits. `session-search-index.js` itself stays unchanged; the composition
happens one layer up, at whatever currently calls `search()`.

### Piece 2: emotional-state tracking -- two separate values

**A. `userAffectState`** (per-user, cross-session, decaying): inputs reuse
`windows-launcher/renderer/reply-emotion.js`'s existing
`detectTextMood()`/keyword-detection logic, ported server-side (it's
currently renderer-only, so this needs extraction into a shared module,
not a rewrite) and run against the *user's* message text each turn instead
of Mana's reply. Each turn: apply exponential decay based on elapsed time
since `lastUpdatedAt`, then nudge the relevant score if a mood was
detected. Storage: a new persistent JSON file (`emotional-state.json`,
sibling to `facts.json`), matching this codebase's flat-file convention for
small state that updates at most once per turn -- unlike the graph's
edge-churn case above, JSON's full-rewrite cost is fine here.

**B. `manaSelfState`** (Mana's own inferred state, cross-session, decaying):
cheapest-first inputs, no new LLM call required by default:
- **Gap since last real conversation** -- `now - session.updatedAt` for the
  most recent session (`acp-memory-store.js` already stores `updatedAt`
  per session) is a free, direct signal for something like "loneliness."
- **Recent reply repetitiveness** -- `rut-detection.js`'s
  `similarityAgainstRecent()` (issue #159) already computes a 0-1 n-gram
  similarity score per reply; a sustained high score is a free,
  already-computed proxy for "stuck in a rut" / low novelty.
- **Optional heavier alternative:** an idle-triggered LLM self-assessment
  call, same pattern as Guardian pre-check's judge call (issue #284) --
  more expensive (one more model round-trip per idle cycle), more
  flexible, and should stay opt-in/env-gated the same way Guardian
  pre-check and the content scan already are, not the default.

Storage: same `emotional-state.json` file, a second top-level key.

**Trigger wiring, corrected:** round 1 said the idle-report handler was
*the* existing trigger mechanism. Reading further, `server.js` already
runs two independent `setInterval` timers unrelated to idle-report -- a
background-memory compactor tick (`server.js:1420-1433`) and an hourly
reviewer tick (`server.js:1435-1450`), both gated by the same
`backgroundJobsPausedForGaming()` check. These are a better fit for the
decay+threshold check than the idle-report handler alone: "has it been N
hours since we last talked" needs to be checkable on a clock tick even
while the user is present-but-not-yet-idle, or while the launcher (and
therefore the only source of idle-reports) isn't even running. Recommend a
third interval -- or folding the check into the existing hourly reviewer
tick -- that applies decay, checks both states' thresholds, and fires
reflex passes, reusing `triggerIdleConsolidation`'s established
"independent try/catch-wrapped passes" composition pattern for what
actually runs once a threshold trips.

## Recommendation

Both pieces now have a concrete enough design (schema, cap strategy,
trigger wiring, module boundaries) to be handed to a real implementation
pass as two separate issues -- consistent with the issue's own "could end
up being separately scoped" note. Still no code written in this pass;
that's a deliberate stop before implementation, not a remaining blocker.

## Out of scope for this doc

No code changes. Round 2 resolved the piece-2 product question (track both
values, per an explicit decision) and went deep enough on piece 1 to reach
an implementable design, but neither piece has been built.
