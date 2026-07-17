# Issue 69: Idle-Triggered Dream Mode — Real OS Idle Detection + Persistent MEMORY.md

## Goal

Replace Mana's timer-based background memory consolidation with real
user-idle detection, and give it a genuine persistent, human-readable
`MEMORY.md` output instead of only an internal JSON cache.

## Why

Mana already runs background memory consolidation — it's just on a fixed
hourly clock, not tied to actual user activity, and its output isn't a
real standalone document today:

- `node-bot/server.js`'s `runBackgroundCompactor()` and
  `runBackgroundReviewer()` already exist and do real work:
  `runBackgroundCompactor` re-aggregates every session's `.summary` field
  (from `node-bot/acp-memory-store.js`), hashes the result, and asks a
  model (remote or local) to compact it into one block if it changed.
  `runBackgroundReviewer` goes further, asking a model to identify
  redundant summaries and return `{compacted, important_facts,
  remove_indices}` to prune stale entries.
- Both jobs are scheduled via plain `setInterval`
  (`MANA_BACKGROUND_MEMORY_REFRESH_MS`, `MANA_BACKGROUND_MEMORY_REVIEW_MS`,
  both default 1 hour) — not tied to whether the user is actually away
  from the keyboard. There's also an existing gaming-aware pause
  (`backgroundJobsPausedForGaming()`, checks running process names) but
  that's process-detection, not real user-idle detection — no
  keyboard/mouse-inactivity timer or OS idle API (e.g. Electron's
  `powerMonitor.getSystemIdleTime()`) exists anywhere in the codebase
  today.
- The persisted output (`node-bot/data/acp-memory/background_meta.json`)
  is a derived cache keyed by file mtimes/hashes for the *compactor's own
  bookkeeping* — not a human-readable, directly-editable `MEMORY.md`. No
  `.md` memory file exists anywhere in the repo today.

## Proposed Scope

- Add real idle detection: `windows-launcher` (Electron main process,
  which already has `powerMonitor`-adjacent capabilities via its other
  IPC/process-management code) reports system idle time to the backend,
  or the backend itself polls an idle signal via IPC from the launcher on
  an interval.
- Gate `runBackgroundCompactor`/`runBackgroundReviewer` on "20+ minutes
  idle" (configurable) in addition to (or instead of) the current
  fixed-hour timer, so consolidation happens when the user is actually
  away, not on an arbitrary clock tick.
- Add a genuine `MEMORY.md`-style output: a human-readable markdown file
  (distinct from `background_meta.json`) distilling core user
  preferences, active tasks, and critical project updates, written after
  a successful idle-triggered consolidation pass. Keep
  `background_meta.json` as the internal bookkeeping cache; `MEMORY.md`
  is the new, user-facing artifact.
- Decide how "safely wipes the bloated raw active context" should
  actually work given Mana's existing per-session storage: this likely
  means trimming/compacting `acp-memory-store.js`'s per-session `turns`
  arrays more aggressively after a successful idle consolidation, not
  deleting session files outright — needs explicit scoping so a user's
  actual conversation history isn't silently destroyed.

## Acceptance Criteria

- Idle detection accurately reflects real user inactivity (verified
  manually: leave the machine idle for the configured threshold, confirm
  a consolidation pass fires that wasn't just the hourly timer).
- A real `MEMORY.md` file is produced and updated after an idle-triggered
  pass, readable as plain text, not just JSON.
- The existing hourly-timer path continues to work as a
  fallback/backstop (so memory consolidation doesn't silently stop
  happening if idle detection fails for any reason).
- Gaming-mode pause behavior (`backgroundJobsPausedForGaming`) is
  preserved — idle-triggered consolidation should not fire while a
  watched game process is running even if the user is otherwise "idle" at
  the keyboard.
- Whatever "wipes the raw active context" scope is chosen, it's
  reversible or at minimum non-destructive to a user's ability to recall
  recent conversation (no silent, permanent data loss).

## Notes

Part of a 3-issue initiative:
- #68 — dynamic VRAM hotswap tuning
- #70 — Best-of-N self-voting inference
