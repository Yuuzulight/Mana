# Issue 643: Load Memory Into Cron Job Prompts, Not Just Write Results Back After

## Goal

Let scheduled cron jobs see what Mana already knows before they run, not
just report results back afterward.

## Why

`plugins/cron-scheduler/index.js` already writes each job's outcome to
memory afterward — `deps.acpMemoryStore.appendTurn()` fires once a job
completes (with a comment explicitly citing issue #423 for why: "a
scheduled job's result should reach the user even if they never reopen
that job's chat session"). But a grep of the same file for
`buildPromptMemory`/`BACKGROUND_MEMORY`/`MEMORY_BLOCK` turns up nothing —
the job's own prompt is never seeded with the curated memory summary
before it runs, only written to afterward.

Hermes Agent's cron system changed exactly this in v0.21.0: "cron jobs
now load and update persistent memory like every other agent" —
MEMORY.md/USER.md load into the system prompt the same way a normal chat
turn's does, not just a one-way result write.

Practical effect on Mana: a recurring job that's supposed to act on the
user's stated preferences, ongoing projects, or prior context currently
runs blind to all of that, then reports back into memory as if starting
fresh each time.

## Proposed Scope

- Wire cron-scheduler's job-execution path to load the same
  background-memory summary (`buildPromptMemory` or equivalent) that
  normal chat turns already get, before constructing the job's prompt.
- Keep the existing after-the-fact `appendTurn()` write unchanged — this
  is additive (read before + write after), not a replacement.

## Acceptance Criteria

- A cron job's prompt demonstrably includes the current memory summary
  (verifiable via a test job that references a fact known only from
  prior memory).
- No regression to the existing result-write-back behavior.

## Related

`docs/roadmap/hermes-desktop-eval-2026-09.md`.
