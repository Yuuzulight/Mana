# Issue 620: Restructure Dream Mode As A Composable Extract/Enrich Pipeline, Add Bi-Temporal Edge Validity

## Goal

Give Mana's idle-triggered Dream Mode consolidation a concrete internal
structure (a registry of independent extract/enrich tasks) instead of
one monolithic routine, and give the memory graph's edges a validity
window so consolidation can tell "true now" from "true once" without
deleting history.

## Why

`node-bot/memory-graph.js` implements a Hebbian associative graph over
entity-co-occurrence pairs -- SQLite edges with a single scalar weight
that reinforces on co-occurrence, with degree-capped eviction of the
weakest edge. It has no typed relations, no fact semantics, and no notion
of an edge being "no longer true." Dream Mode consolidation currently
runs as a single idle-triggered process on top of this.

`docs/roadmap/oss-inspiration-survey-2026-08.md` already tagged
Zep/Graphiti's bi-temporal fact model `borrow` and partially scoped it as
issue #432 (credited to cognee's ontology-typed extraction, not Graphiti
specifically). This new research reinforces and extends that from two
more open projects:

- **cognee's `memify`**: a post-processing stage that never ingests raw
  data itself, but is explicitly a composable chain of an *Extraction*
  task (pull a working set out of the existing graph -- chunks, triplets,
  cached turns, or nodes of a type) and an *Enrichment* task (process
  that set, often via an LLM call, write new/updated nodes and edges
  back). Built-in pipelines include `consolidate_entity_descriptions`
  (merge fragmented per-entity descriptions using the entity's local
  neighborhood as context), `cross_connect_entities`, and
  `add_rule_associations`.
- **Graphiti's bi-temporal edges**: every fact carries
  `t_valid`/`t_invalid` (when it was true in the world) separate from
  `t_created`/`t_expired` (when the system learned/retracted it). New
  information that contradicts an existing edge closes its validity
  window instead of deleting or overwriting it, so "what did I believe
  was true in March" stays queryable alongside current state.

## Proposed Scope

- Define Dream Mode as a small registry of independent extract/enrich
  task pairs (e.g. entity-description merging, derived-edge inference,
  staleness pruning) run in sequence over idle cycles, rather than one
  monolithic routine -- each task independently skippable under
  gaming-mode resource backoff.
- Implement `consolidate_entity_descriptions`-style neighborhood-
  conditioned merging as the first concrete task: pull an entity node's
  local neighborhood, have the local chat LLM produce one merged
  description, replace the fragments.
- Add a valid-from/valid-to pair to memory-graph edges (even without the
  full ingestion-time pair Graphiti also tracks), and update Dream
  Mode/retrieval to prefer the currently-valid edge without deleting
  superseded ones.
- This is additive to the existing Hebbian association-strength graph,
  not a replacement -- association strength (how often two things
  co-occur) and fact validity (whether a stated fact is still true) are
  different axes and should coexist.

## Acceptance Criteria

- Dream Mode runs as a documented, independently-testable sequence of
  extract/enrich tasks rather than one opaque routine.
- At least one entity-description-merging task is implemented and
  demonstrably reduces duplicate/fragmented descriptions for a repeated
  entity across multiple conversations.
- Memory-graph edges carry a validity window, and a superseded fact (e.g.
  "lives in city A" -> "lives in city B") is retrievable as historical
  without being silently overwritten or duplicated as an unrelated new
  edge.

## Related

#432 (ontology-typed extraction + derived-facts).
`docs/roadmap/oss-inspiration-survey-2026-09.md` (full research backing).
