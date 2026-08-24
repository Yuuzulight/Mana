# Issue 431: Bi-Temporal Fact Invalidation In The Memory Graph

## Goal

Let Mana's memory graph track when a fact stopped being true, not just
overwrite or delete it when it's superseded.

## Why

Inspired by Zep/Graphiti: every graph edge carries two timestamps -- when
a fact became true in the world, and when the system learned it. A
contradicting new fact marks the old edge invalid rather than
overwriting/deleting it, so the full timeline stays queryable ("what did
I believe was true in March?"). Mana's Hebbian memory graph (#285) tracks
associative strength, not fact validity over time -- a distinct axis. See
`docs/roadmap/oss-inspiration-survey-2026-08.md`.

## Proposed Scope

- Add valid-from / invalidated-at timestamps to entity/relation edges.
- A contradicting fact marks the prior edge invalid instead of
  deleting/overwriting it.
- Queries can optionally ask "what was true as of <time>" instead of only
  current state.

## Acceptance Criteria

- A contradicted fact's prior edge is preserved and marked invalid, not
  deleted.
- A time-scoped query can retrieve what was believed true at a past point.
- Existing associative-strength (Hebbian) behavior is unchanged.

## Related

#285
