# Issue 419: Wire The Test Runner Into The Autonomous Coding Loop

## Goal

Make test failures during coding-agent edits drive bounded retries,
instead of the test runner and the autonomous loop being two disconnected
primitives.

## Why

`node-bot/acp-test-runner.js` (guarded, allowlisted test runner) and
`node-bot/acp-autonomous-loop.js` (tool-call loop with per-session call
caps) don't talk to each other today -- confirmed by grep, no reference
from one to the other. The "verification loop" (run tests, parse
failures, retry) is called out repeatedly as the highest-leverage
capability across current coding agents. See
`docs/roadmap/oss-inspiration-survey-2026-08.md`.

Not a duplicate of #356/#378, which added a parse-check specifically for
`skill-proposal.js`-generated skill scripts -- a separate subsystem from
the editor-handoff/autonomous-loop coding path this issue targets.

## Proposed Scope

- After a proposed edit, run the allowed test command via
  `acp-test-runner.js`.
- On failure, feed the failure output back into `acp-autonomous-loop.js`
  as context for another attempt.
- Cap retries (small, bounded number -- match the existing per-session
  call-cap philosophy) before falling back to the approval gate as-is.

## Acceptance Criteria

- A failing test after a proposed edit triggers at least one automatic
  retry attempt with the failure output as context, before falling back
  to human review.
- Retries are capped and logged/visible, not silent or unbounded.
- Existing approval-gate behavior is unchanged when tests pass or when
  retries are exhausted.
