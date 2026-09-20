# Issue 646: Add A Live Activity/Steering Panel For The Coding Agent's Running Tasks

## Goal

Give the user visibility into what Mana's coding agent's delegated
sub-tasks are doing while they run, with the ability to steer or stop one
mid-flight.

## Why

Mana's coding agent runs as a single linear ACP tool-calling loop
(confirmed in the earlier DIY-AI/JARVIS research pass) — there's no
subagent/delegated-worker concept in the current architecture, and
therefore no UI surface for monitoring one either.

Hermes Desktop shows a live "Subagents" frame while delegated workers
execute: worker count, task names, elapsed time, latest activity, with a
Steer/Stop control per worker (previews up to three, expandable to the
full roster). This is useful independent of whether Mana adopts true
parallel subagents or not — even a single delegated sub-task benefits
from a visible "what is it doing right now, and can I stop it" surface,
which doesn't exist today for the autonomous coding agent's tool-calling
loop.

## Proposed Scope

- If/when Mana's coding agent gains any form of task delegation (parallel
  or sequential sub-tasks with isolated scope — see the "Claude Code
  subagents" finding in `docs/roadmap/oss-inspiration-survey-2026-09.md`),
  add a live status panel: task name, elapsed time, latest tool call,
  with Stop (and ideally Steer — inject a follow-up instruction)
  controls.
- As a smaller first step independent of subagent architecture: surface
  the *current* single ACP loop's live activity (which tool is running,
  how long) in the UI, since even that isn't currently visible outside
  the diff-preview/approval-gate moment.

## Acceptance Criteria

- The coding agent's current activity (tool name, elapsed time) is
  visible in the UI while a task is running, not just at the
  approval-gate checkpoint.
- A user can stop an in-progress coding-agent run from the UI.

## Related

`docs/roadmap/hermes-desktop-eval-2026-09.md`. Related to the "Claude
Code subagents" finding in
`docs/roadmap/oss-inspiration-survey-2026-09.md`.
