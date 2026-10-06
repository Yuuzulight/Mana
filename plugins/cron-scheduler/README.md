# cron-scheduler

Run something on a fixed schedule -- a daily summary, a periodic health
check -- independent of chat activity or idle detection. On by default;
it can be switched off in Settings > Connections > Plugins, which also
turns off the heartbeat checks.

Two job types:

- **`script`**: calls a named function from the `scriptActions` registry
  passed in at wiring time (e.g. `{ ffxivMarketSummary: () => ... }`). No
  model call.
- **`agent`**: asks Mana's normal reply pipeline (`buildAssistantReply`) a
  prompt, exactly as if the user had typed it in that session -- so it
  sees the same memory a chat turn does (background memory, the session's
  own memory, pinned and related facts), except that only confirmed facts
  are used: unverified and pending (unconfirmed) ones stay out, since
  there's nobody to check them with.
- **`reminder`** (#905): the job's `name` is the reminder text; no model
  call. Mana sets, lists and cancels these from chat
  (`node-bot/ai/reminder-tool-source.js`). They go out as a "Reminder" toast
  through the proactive engine as explicit, so they get through even
  mid-game, and the payload's `speak` line ("Yuuzu, raid in 10 minutes!")
  is said out loud by the native launcher. They fire whether or not this
  plugin is enabled.

Either way, the result (or error) is delivered as a chat turn
(`acpMemoryStore.appendTurn`) in the job's session -- visible in the
existing Sessions list UI, no new frontend surface needed.

## Scheduling

Deliberately just two schedule shapes, not a full cron-expression parser:

- `{ type: "interval", everyMs }` -- fire every `everyMs` milliseconds.
- `{ type: "daily", hour, minute }` -- fire once a day at that local time.
- `{ type: "once", at }` -- fire once at that timestamp (ms), then the job
  is removed. One that came due while the backend was down fires on start.

Covers every example in the issue (a daily 9am summary, a periodic check)
without pulling in a cron-expression dependency. If a real need for comma
lists / step values / weekday filters shows up, that's a `computeNextRun`
change in `cron-scheduler.js`, not a rewrite.

## Heartbeat (#699)

`node-bot/data/cron-scheduler/heartbeat.md` is a checklist Mana runs in
the background, one check per `-` line. She only speaks up when a check
finds something you need to know or act on, and that report is a proactive
remark like any other (daily budget, gaming hold, quiet hours; `urgent`
skips the budget). Settings > Heartbeat in the launcher edits the list:

```
- [read, network] every 30m: check github.com notifications for review requests
- [read, write] daily 09:00: append yesterday's summary to D:\Notes\journal.md
- warn me if D: drops below 50 GB
```

- No permission list = read only. `write` and `network` calls run
  unattended, but only inside the folders/files and sites the check's text
  names (so name the site: `github.com`, not "GitHub"). Every write is
  snapshotted first and listed in the next report. `install` and
  `destructive` can't be granted; those calls always wait in the approval
  queue. `urgent` lets the check's reports skip the daily budget.
- A struck-through line (`- ~~every 30m: ...~~`) is switched off.
- Default interval 30 minutes; `every 15m:`, `every 2h:`, `daily 09:00:`
  override it (5 minutes at the shortest).
- A new or edited check (different permissions or text) does a dry run
  first: read calls, plus Mana's own built-in page fetch
  (`browser_automation__navigate`) from the sites its own line names when it
  has `network`. MCP/add-on tools, shell commands and page clicks never run
  in a dry run, whatever their names; they only run once the check is
  approved. It then waits in the approval queue with what it
  would have said. Approving it takes it live.
- Nothing runs while a watched game is running, or while this plugin is
  disabled.
- Checks only see confirmed memory facts, never unconfirmed ones, the same
  as cron agent jobs.

## Routes

- `GET /cron/jobs` -- list all jobs.
- `POST /cron/jobs` -- `{ name, jobType, schedule, actionName | prompt, sessionId?, enabled? }`.
- `DELETE /cron/jobs/:id` -- remove a job.
- `GET /heartbeat/items` -- heartbeat.md's checks as `{ items: [{ id, text, schedule, permissions, urgent, enabled }] }`.
- `PUT /heartbeat/items` -- `{ items }` replaces the checks in order (headings and notes stay); a bad item is a 400 and nothing is written.

## Why the core logic is dependency-injected

`createCronScheduler({ dataDir, now, makeId, scriptActions, runAgentJob, onResult })`
takes every side effect as an option, same pattern as `acp-memory-store.js`
-- `now`/`makeId` make scheduling math deterministic in tests, and
`scriptActions`/`runAgentJob`/`onResult` keep this module free of any
direct coupling to server.js's reply pipeline or a specific plugin's
actions.
