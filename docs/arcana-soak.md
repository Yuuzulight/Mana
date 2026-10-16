# Arcana soak: a week of browsing without anyone at the keyboard

Arcana's M2 exit is a week of Mana's browser use with no unexplained fallback to Edge. `tools/arcana-soak.js`
produces that evidence on its own: it drives Mana's browser plugin (the same code her tools call) on Arcana
through a short script per site, and keeps score.

- `tools/arcana-soak-schedule.ps1` registers a Windows scheduled task, "Mana Arcana soak": the first run is at
  08:00 Singapore time (`-StartAt` changes it), then every 4 hours for 7 days, no window, below-normal priority,
  never overlapping itself, waking the PC if it has to, and a missed run happens when the PC is back. `-Remove`
  takes it away again.
- A run is skipped, and the skip is recorded, while a game is open or RAM is at or over 85%.
- Everything is under `node-bot/data/arcana-soak`: `runs.jsonl` (a line per site per run), `events.jsonl` (the
  plugin's engine log), `report.md` (rewritten after every run) and the browser's own profile, so it never touches
  the profile Mana browses with.
- `node tools/arcana-soak.js --report` prints the last seven days.

Each site result is one of:

| Result | Meaning |
|---|---|
| ok | every step worked |
| known | it failed the way a filed Arcana issue says (Arcana#5 tables, #6 clicks, #7 YouTube, #8 Amazon, #9 GitHub speed) |
| blocked | the site put up a bot wall; Edge sees the same |
| unexplained | anything else, or Arcana failed to start and Mana fell back to Edge |

The verdict is `clean` only after seven observed days, at least two completed runs a day, no start failure or
unasked disconnect, and no unexplained result; `investigate` when there is one; `insufficient` before that. A known
gap that gets fixed starts reporting ok by itself.
