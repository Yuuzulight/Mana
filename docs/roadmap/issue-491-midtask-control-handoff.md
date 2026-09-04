# Issue 491: Mid-Task Manual Control Handoff

## Goal

Let the user step in and take manual control of an in-progress autonomous
run, not just approve/reject before it starts or wait for it to finish.

## Why

Salvaged from scoping out OpenBot's broader multi-agent governance model
(#490) -- OpenBot supports a live manual control handoff for complex
tasks requiring human intervention, distinct from pre-execution approval.
Mana's approval gate (#152) only reviews proposed actions before
execution; once the coding autonomous loop or a Deep Research subagent
run is underway, there's no way to step in mid-task.

## Proposed Scope

- Add a way to pause an in-progress autonomous run (coding loop or Deep
  Research subagent) and hand control to the user.
- Scope to the two existing autonomous-run surfaces (coding loop, Deep
  Research); don't build a general-purpose framework ahead of a third
  surface needing it.

## Acceptance Criteria

- A running autonomous coding loop or Deep Research subagent run can be
  paused mid-task by the user.
- Paused state is resumable or cleanly cancellable, not a dead end.

## Related

#490, #152
