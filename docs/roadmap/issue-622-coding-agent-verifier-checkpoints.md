# Issue 622: Add An Adversarial LLM Verifier To The Coding Agent (Static Verifier And Checkpoint Store Already Shipped)

## Correction notice

A follow-up codebase audit (2026-09-12) found this issue's premise was
wrong: the coding agent already has a verification pass and a
checkpoint/restore system, both distinct from the plain
approval-gate/diff-preview handoff originally described. Scope narrowed
to what's genuinely still missing.

## Goal

Add an adversarially-prompted LLM sub-agent verifier as a second,
differently-shaped check on top of the coding agent's existing static
verifier -- not a first safety layer, since one already exists.

## Why

The original research described the coding agent as having "a single
layer: an approval gate plus a diff-preview handoff to a human editor."
That undersells what's already there:

- **A verification pass already runs**:
  `node-bot/utils/reply-verifier.js`'s `verifyReply()` does syntax/AST
  checks, secret-pattern regex, and dangerous-shell-command detection,
  gating replies with an auto-retry loop (`server.js:4411-4462`). This is
  real, but it's static/heuristic, not an adversarial LLM sub-agent
  prompted to find where a change breaks -- that specific gap (the actual
  finding worth keeping from the original research) is real.
- **A checkpoint/restore system already runs**:
  `node-bot/snapshot-store.js` (explicitly documented as "independent of
  git" per `server-routes.js:892`) is called via
  `snapshotStore.recordSnapshot({kind: "file", ...})` before every file
  write in `acp-autonomous-loop.js:718`, with `snapshot_restore`/
  `snapshot_list` tools (794-865) and
  `/editors/workspace/snapshots(/:id/restore)` routes. This is
  JSON-based rather than git-based, but functionally the same
  retrospective safety net Cline's shadow-git pattern was cited for.

## Proposed Scope

- Add a separate adversarially-prompted LLM sub-agent that reviews a
  proposed diff and returns a typed refute/failing-case verdict, distinct
  from `reply-verifier.js`'s existing static checks -- run it before the
  diff reaches the human approval gate, gated to changes that touch logic
  to control cost.
- Evaluate whether the existing JSON-based `snapshot-store.js`
  checkpointing is sufficient, or whether a git-based whole-workspace
  checkpoint offers something it doesn't (e.g. diffing against an
  arbitrary prior checkpoint, not just restoring one file).

## Acceptance Criteria

- At least one adversarial verifier stage runs before a diff reaches the
  human approval gate, with a documented before/after on a small set of
  intentionally-buggy test diffs (does it catch bugs `reply-verifier.js`'s
  static checks miss?).
- A clear recommendation on whether `snapshot-store.js` needs to be
  extended or replaced, rather than assuming git-based checkpointing must
  be added from scratch.

## Related

`docs/roadmap/oss-inspiration-survey-2026-09.md`.
