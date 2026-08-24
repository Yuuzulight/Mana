# Issue 433: Evaluate A mem0-Style ADD/UPDATE/DELETE/NOOP Memory Engine

## Goal

Decide whether a formal ADD/UPDATE/DELETE/NOOP decision engine for
incoming facts adds anything Mana's memory system doesn't already do.

## Why

Inspired by mem0's LLM-judged CRUD decision per incoming fact against
existing memory. See `docs/roadmap/oss-inspiration-survey-2026-08.md`.

## Note -- flagged low-priority in the survey

This mechanically overlaps with what Dream Mode consolidation already
does, plus the contradiction-detection idea already logged from the July
survey (`oss-inspiration-survey-2026-07.md`, Soul of Waifu) and the
archive action added in #277. Reads as "another memory database with
LLM-judged CRUD" rather than a genuinely new mechanism.

## Proposed Scope

- Triage against #277 and the contradiction-detection idea before
  committing to anything.
- Likely outcome: close as redundant, unless a gap neither of those
  covers is identified.

## Acceptance Criteria

- A documented triage decision exists (build / redundant / partial gap
  identified), same as other scoped-not-implemented items in this
  directory.

## Related

#277, `docs/roadmap/oss-inspiration-survey-2026-07.md`
