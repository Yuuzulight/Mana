# Issue 622: Add Adversarial Verification And Shadow-Git Checkpoints To The Coding Agent's Approval Gate

## Goal

Catch more bad diffs before a human sees them, and add a retrospective
safety net for Mana's autonomous coding agent that doesn't depend on the
human catching everything at approval time.

## Why

Mana's ACP-based coding agent has a prospective control today: an
approval gate plus a diff-preview handoff to a human editor. That's a
single layer -- it does nothing if the user rubber-stamps a bad diff, or
if a later step in a multi-step agent run does something an earlier
approval didn't anticipate. Two documented practitioner patterns address
these gaps directly and independently:

- **Adversarial "skeptic" verifier sub-agent**: instead of asking the
  same generating model "is this correct?" (which inherits its own blind
  spots), a separate agent is prompted adversarially to find where the
  change breaks, defaults to "refuted" unless safety is demonstrated, and
  returns a typed verdict (boolean + concrete failing case) rather than
  free text. Running 2-3 differently-specialized skeptics (logic
  correctness, security/validation, behavior reproduction) roughly
  doubled bug detection versus running one verifier three times in the
  source writeup, with verification gated to logic-touching changes only
  to control cost. Reported result: ~1 in 6 "approved" changes had bugs
  the test suite missed.
- **Cline's shadow-git checkpoints**: a hidden git repository, separate
  from the user's real project history, commits a full workspace
  snapshot (including untracked files) after every tool action the agent
  takes. Users get a diff view against any checkpoint and can restore
  files, conversation, or both. This is retrospective and composes with
  -- rather than duplicates -- a prospective approval gate.

## Proposed Scope

- Add an adversarial verifier step between diff generation and human
  approval: at minimum one skeptic agent prompted to refute the change,
  gated to changes that touch logic (skip trivial/mechanical diffs to
  control cost given local model latency).
- Add shadow-git checkpointing to the coding agent's tool-calling loop: a
  separate git working tree, one commit per tool action, with a way to
  view a diff against or restore to any checkpoint.
- These are additive to the existing approval gate, not a replacement for
  human review.

## Acceptance Criteria

- At least one adversarial verifier stage runs before a diff reaches the
  human approval gate, with a documented before/after on a small set of
  intentionally-buggy test diffs (does it catch bugs the generator itself
  missed?).
- Shadow-git checkpoints are created automatically during coding-agent
  runs, and a user can view/restore from any checkpoint independent of
  the approval-gate diff.

## Related

`docs/roadmap/oss-inspiration-survey-2026-09.md` (full research backing).
