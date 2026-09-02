# Issue 497: Evaluate A Navigable Filesystem-Paradigm Context Store

## Goal

Decide whether Mana's skills store and/or memory retrieval would benefit
from an explicitly navigable hierarchical structure, versus the current
index-then-load (skills) and hybrid keyword+vector (memory) approaches.

## Why

Inspired by volcengine/OpenViking, a context database for AI agents that
unifies memory, resources, and skills under a filesystem paradigm -- the
agent browses hierarchically instead of everything living in one flat
vector-embedding pool. Mana's skills store (#140) is already file-based,
which makes it the more natural first candidate to compare against.

## Proposed Scope

- Evaluation only, not a commitment to adopt the whole design.
- Compare "agent navigates context like a filesystem" against Mana's
  current approaches for skills (#140, index-then-load) and memory (#263,
  hybrid keyword+vector) on Mana's actual corpus sizes.
- If a clear win exists for either surface, scope a follow-up
  implementation issue; otherwise close as evaluated-not-adopted.

## Acceptance Criteria

- A documented comparison exists: does hierarchical navigation
  meaningfully outperform (in relevance, latency, or model-usability
  terms) Mana's current skills/memory retrieval, on Mana's own data.
- A clear build/don't-build recommendation, same as other evaluate-first
  items in this directory.

## Related

#140, #263
