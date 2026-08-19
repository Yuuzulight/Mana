# Issue 422: Run Test Verification Against A Scratch Copy Of The Workspace

## Goal

Stop a test run with side effects (temp files, mutated fixtures) from
being able to corrupt the live working tree during coding-agent
verification.

## Why

`acp-test-runner.js` currently runs allowlisted test commands directly
against the live workspace. Full Docker-per-task isolation (OpenHands'
approach) is the wrong weight class for a single-user Windows companion
app with no Docker dependency -- deliberately scoped narrower here. See
`docs/roadmap/oss-inspiration-survey-2026-08.md`.

Not a duplicate of #352, which is about OS-level sandboxing for
*generated skill script execution* (`script-runner-worker.js`, a security
boundary against adversarial content) -- a different subsystem and a
different concern from this issue's target (safety of test runs against
in-progress edits, not security isolation against hostile input).

## Proposed Scope

- Before running the test command, copy the workspace (or just the
  changed files plus their dependency closure, if that's cheap enough) to
  a scratch directory.
- Run the test command there instead of the live tree.
- Report results back into the normal proposal/approval flow unchanged.

## Acceptance Criteria

- A test run that writes temp files or mutates fixtures does not touch
  the live working tree.
- Test results reported to the approval flow are unchanged in shape/
  meaning from today's direct-run behavior.
- No meaningful latency regression for typical test suite sizes.
