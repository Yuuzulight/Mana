# Issue 144: Built-in Cron Scheduler

## Goal

Add time-based automation independent of chat or idle activity -- "run
this every morning at 9am" -- with two job types (script-only, no model
call; agent-driven, asks Mana's normal reply pipeline a prompt) and a way
to list/add/remove jobs.

## Status: Implemented (`plugins/cron-scheduler/`, toggleable, off by default)

- **`cron-scheduler.js`**: `createCronScheduler(options)` -- persists jobs
  to a JSON file (same pattern as `acp-memory-store.js`), a `setInterval`
  loop (default every 30s) that fires any enabled job whose `nextRunAt` has
  passed, then reschedules it. `runDueJobs()` is also directly callable/
  awaitable for tests, independent of the timer.
- **Two job types**: `script` calls a named function from an injected
  `scriptActions` registry (no model call); `agent` calls an injected
  `runAgentJob(job)` -- wired in `index.js` to `buildAssistantReply`, the
  same function every other reply route already shares.
- **Delivery**: every result (or error) goes through `onResult`, wired to
  `acpMemoryStore.appendTurn` -- the job's result lands as a chat turn in
  its configured session, which the existing Sessions list UI in
  `windows-launcher` already renders. No new frontend surface needed.
- **Routes**: `GET /cron/jobs`, `POST /cron/jobs`, `DELETE /cron/jobs/:id`.
- **Toggle**: `category: "Automation"`, `defaultEnabled: false` -- the
  existing plugin-settings mechanism (Settings > Plugins) gates it, same
  as every other toggleable plugin.

## Deliberate simplifications

- **No cron-expression parser, no new dependency.** Just two schedule
  shapes -- `{ type: "interval", everyMs }` and
  `{ type: "daily", hour, minute }` -- computed with plain `Date` math.
  Covers every example the issue actually gives (a daily summary, a
  periodic check); a real cron-syntax need (comma lists, step values,
  weekday filters) is a `computeNextRun` change, not a rewrite.
- **No built-in script actions ship yet.** `scriptActions` is an empty
  object unless whoever wires the plugin into `server.js` passes real ones
  in (e.g. an FFXIV market summary function). The scheduling/execution/
  delivery mechanism is fully implemented and tested; populating the
  registry with concrete actions is a natural, separately-scoped follow-up
  once a specific one is wanted.
- **No CLI or Settings-panel list UI.** Routes exist; a UI to manage jobs
  visually is exactly the kind of thing Settings > Plugins' existing
  "click into a plugin" pattern could add later, out of scope for landing
  the underlying capability.

## Verified

- `plugins/cron-scheduler/test/cron-scheduler.test.js` (12 tests): schedule
  validation, `computeNextRun` for both interval and daily (including the
  today-already-passed rollover), job persistence across store instances,
  removal, a due job firing/delivering/rescheduling, a failing job not
  blocking a sibling job, a disabled job never firing, and an agent job
  routed through the injected executor.
- `plugins/cron-scheduler/test/cron-scheduler-capability.test.js` (5
  tests): all three routes, validation-error surfacing, and plugin
  metadata shape.
- `node-bot/test/health-components.test.js`: updated its hardcoded
  component-key snapshot for `cronScheduler` -- and, while at it, for
  `documentReader`, which turned out to already be missing from that list
  since issue #126 landed (a pre-existing gap, not something this issue
  introduced).
- `node-bot/test/server-routes.test.js` (62 tests): unaffected by the
  `buildAssistantReply` addition to `capabilityContext`.
