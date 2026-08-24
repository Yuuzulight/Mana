# Issue 420: Reject Syntactically Broken Edits Before The Approval Gate

## Goal

Catch a syntactically broken proposed edit before it costs a human review
cycle, instead of only after.

## Why

Inspired by SWE-agent's ACI, which runs a linter at edit time and rejects
broken edits before they're shown to a reviewer. #378 already added
exactly this for one path (skills generated via `skill-proposal.js`,
"refuse a generated skill whose script does not parse") -- this issue
extends the same idea to the editor-handoff proposal path
(`editors/workspace/proposals`), which #378 didn't touch. See
`docs/roadmap/oss-inspiration-survey-2026-08.md`.

## Proposed Scope

- Run a cheap syntax check (`node --check` for JS, appropriate parser for
  other languages already handled by editor handoff) on a proposed edit
  before it reaches the approval gate.
- On failure, block the proposal from reaching review and surface the
  parse error, mirroring what #378 does for skills.

## Acceptance Criteria

- A proposed edit with a syntax error never reaches the human approval
  step -- it's rejected with the parse error attached.
- Valid edits are unaffected; the check adds no perceptible delay to the
  normal proposal flow.
