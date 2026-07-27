# cron-scheduler

Run something on a fixed schedule -- a daily summary, a periodic health
check -- independent of chat activity or idle detection. Disabled by
default (Settings > Plugins); enable it before adding jobs.

Two job types:

- **`script`**: calls a named function from the `scriptActions` registry
  passed in at wiring time (e.g. `{ ffxivMarketSummary: () => ... }`). No
  model call.
- **`agent`**: asks Mana's normal reply pipeline (`buildAssistantReply`) a
  prompt, exactly as if the user had typed it in that session.

Either way, the result (or error) is delivered as a chat turn
(`acpMemoryStore.appendTurn`) in the job's session -- visible in the
existing Sessions list UI, no new frontend surface needed.

## Scheduling

Deliberately just two schedule shapes, not a full cron-expression parser:

- `{ type: "interval", everyMs }` -- fire every `everyMs` milliseconds.
- `{ type: "daily", hour, minute }` -- fire once a day at that local time.

Covers every example in the issue (a daily 9am summary, a periodic check)
without pulling in a cron-expression dependency. If a real need for comma
lists / step values / weekday filters shows up, that's a `computeNextRun`
change in `cron-scheduler.js`, not a rewrite.

## Routes

- `GET /cron/jobs` -- list all jobs.
- `POST /cron/jobs` -- `{ name, jobType, schedule, actionName | prompt, sessionId?, enabled? }`.
- `DELETE /cron/jobs/:id` -- remove a job.

## Why the core logic is dependency-injected

`createCronScheduler({ dataDir, now, makeId, scriptActions, runAgentJob, onResult })`
takes every side effect as an option, same pattern as `acp-memory-store.js`
-- `now`/`makeId` make scheduling math deterministic in tests, and
`scriptActions`/`runAgentJob`/`onResult` keep this module free of any
direct coupling to server.js's reply pipeline or a specific plugin's
actions.
