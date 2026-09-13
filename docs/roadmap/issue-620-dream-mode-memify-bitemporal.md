# Issue 620: Extend memory-graph.js Edges With Fact-Validity, Building On #431/#432

## Correction notice

A follow-up codebase audit (2026-09-12) found this issue's original
premise was substantially wrong: Dream Mode is not a monolithic routine,
and bi-temporal fact validity plus typed-entity merging already ship
today under issues #431 and #432 -- neither was cited in the original
version of this issue. Scope narrowed to the one part that's genuinely
still missing: `memory-graph.js`'s own edges.

## Goal

Give `memory-graph.js`'s Hebbian association edges a validity window,
using the same pattern issue #431 already established for facts --
rather than building bi-temporal validity and consolidation structure
from scratch, both of which already exist elsewhere in the codebase.

## Why

The original research assumed Dream Mode consolidation "runs as a single
idle-triggered process" and that Mana's memory has "no fact semantics, no
typed relations, no notion of an edge being no longer true." Both claims
are false as stated:

- **Dream Mode is already a multi-stage pipeline.** `triggerIdleConsolidation`
  (`node-bot/server.js:1828-1897`) already sequences 6 independently-defined,
  independently try/catch-wrapped stages, each triggered at startup, on
  its own timer, and from the idle signal: `runBackgroundCompactor()`
  (1134), `runBackgroundEntityTyping()` (1256), `runBackgroundReviewer()`
  (1309), `runBackgroundConnections()` (1522), `runSkillProposalPublic()`
  (1869), `idleSkillsStore.pruneStaleSkills()` (1884). One stage failing
  never blocks the others -- already functionally the "independently
  skippable" registry this issue originally proposed building.
- **Bi-temporal fact validity already ships** (issue #431,
  `node-bot/acp-memory-store.js`): every fact carries
  `validFrom`/`invalidatedAt`; a `history` array preserves each prior
  value with its own validity window (lines 598-609); `applySupersedes()`
  (94-119) closes a superseded fact's validity window instead of
  deleting/overwriting it; `invalidateFactByKey()` (674) does the same
  standalone; `getFactsValidAt(asOf)` (700-721) reconstructs "what did I
  believe was true on date X" -- functionally the same pattern this issue
  attributed to Graphiti and proposed as new.
- **Typed entities + LLM-driven merge already ship** (issue #432,
  `node-bot/entity-ontology.js` + the `runBackgroundEntityTyping` stage
  above): entities are typed into an 8-category ontology, then go through
  an extract-candidates -> LLM-judge -> merge pipeline
  (`findEntityMergeCandidates`, `buildEntityMergeJudgePrompt`,
  `setCanonicalAlias`) that collapses fragmented/duplicate entities -- the
  same shape as the cognee-inspired `consolidate_entity_descriptions`
  pattern this issue proposed adding.

What's genuinely still true: `node-bot/memory-graph.js` itself (the
Hebbian co-occurrence graph -- `CREATE TABLE
memory_graph_edges(node_a, node_b, weight, last_reinforced_at)`) has no
type column, no validity window, and no fact semantics. It remains a pure
scalar-weight association graph, distinct from (and complementary to) the
fact-validity/typed-entity work in #431/#432.

## Proposed Scope

- Extend `memory_graph_edges` with the same `validFrom`/`invalidatedAt`
  pattern `acp-memory-store.js` already uses for facts -- not a new
  bi-temporal system, the existing one applied to this table.
- Decide whether association-strength decay/edge closure should route
  through the existing `applySupersedes()`/`invalidateFactByKey()`
  machinery or needs its own narrower variant, given `memory-graph.js`
  edges are untyped pairs, not discrete facts.
- If further entity-description consolidation is wanted beyond what
  `runBackgroundEntityTyping`'s merge pipeline already does, scope it
  explicitly as an extension of that existing pipeline, not a new one.

## Acceptance Criteria

- `memory-graph.js` edges carry a validity window using the established
  `validFrom`/`invalidatedAt` pattern, and a superseded association is
  retrievable as historical rather than silently overwritten.
- This issue's scope is demonstrably additive to #431/#432, not a
  duplicate -- explicitly cite both in any implementation PR.

## Related

#431 (bi-temporal fact validity, already shipped), #432 (typed-entity
extraction + derived-facts, already shipped).
`docs/roadmap/oss-inspiration-survey-2026-09.md`.
