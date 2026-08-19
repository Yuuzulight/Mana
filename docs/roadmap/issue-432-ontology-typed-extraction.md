# Issue 432: Ontology-Typed Entity Extraction + Derived-Facts Pass

## Goal

Tighten entity/relation extraction against a defined vocabulary, and add
a pass that infers new facts from existing graph structure instead of
only recording what was explicitly stated.

## Why

Inspired by cognee: typed extraction against a defined ontology cuts
synonym/drift noise versus open-vocabulary LLM labels, and a
post-ingestion pass infers derived facts via multi-hop/transitive graph
structure. Mana's cross-session entity tagging (#78) uses open-vocabulary
labels today. See `docs/roadmap/oss-inspiration-survey-2026-08.md`.

## Proposed Scope

- Part A: define a small ontology for Mana's entity types; extract
  against it instead of open-vocabulary labels.
- Part B: add an inference pass that derives new facts from existing
  graph structure, distinct from Dream Mode consolidation and existing
  connection-making.

## Acceptance Criteria

- Entity extraction produces consistent types from the defined ontology
  instead of ad hoc labels for the same underlying entity.
- The inference pass surfaces at least one class of derived fact that
  wasn't explicitly stated in any single conversation.
- No regression to existing entity tagging (#78) behavior for cases the
  ontology doesn't cover.

## Related

#78
