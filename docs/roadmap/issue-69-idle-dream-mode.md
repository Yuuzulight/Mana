# Issue 69: Idle-Triggered Dream Mode

## Goal

Replace Mana's timer-based background memory consolidation with real
user-idle detection, and give it a genuine persistent, human-readable
`MEMORY.md` output instead of only an internal JSON cache.

## Why

Mana already runs background memory consolidation (`runBackgroundCompactor`,
`runBackgroundReviewer` in `node-bot/server.js`) on a fixed hourly
`setInterval`, not tied to whether the user is actually away from the
keyboard. The persisted output (`background_meta.json`) is a derived cache
for the compactor's own bookkeeping, not a human-readable artifact.

## Proposed Scope

- Real idle detection via Electron's `powerMonitor.getSystemIdleTime()` in
  windows-launcher, reported to the backend.
- Gate consolidation on "N minutes idle" (configurable), in addition to the
  existing hourly timer, which stays as the fallback/backstop.
- A genuine `MEMORY.md` markdown file distinct from `background_meta.json`.

## Status: Implemented

- **Idle reporting**: `windows-launcher/main.js` polls
  `powerMonitor.getSystemIdleTime()` every 60s and POSTs it (best-effort,
  fire-and-forget) to a new `POST /internal/idle-report` route.
- **Idle gate**: `node-bot/server.js`'s `/internal/idle-report` handler
  compares the reported idle seconds against `MANA_IDLE_THRESHOLD_MS`
  (default 20 minutes). Crossing the threshold fires the same compactor +
  reviewer pass the hourly timer runs, exactly once per idle period (a flag
  resets when idle time drops back below the threshold, so staying idle for
  hours doesn't re-trigger consolidation on every ~60s report). The existing
  gaming-pause check (`getGamingStatus().gamingAppRunning`) applies here too.
- **Fallback preserved**: the hourly `setInterval` calling
  `runBackgroundCompactor`/`runBackgroundReviewer` is untouched, so
  consolidation keeps happening on its own even if idle reporting never
  arrives (headless backend, launcher not running, etc.).
- **MEMORY.md**: a new `writeMemoryMarkdown()` helper renders
  `BACKGROUND_MEMORY_META.lastCompacted.text` and `.important_facts` into
  `node-bot/data/acp-memory/MEMORY.md`, called after every successful
  compactor/reviewer pass (idle-triggered or hourly) that actually produces
  or updates a compacted summary.

### Deliberately skipped: aggressive `turns` trimming

The issue's proposed scope also floated trimming `acp-memory-store.js`'s
per-session `turns` arrays more aggressively after an idle-triggered pass
("safely wipes the bloated raw active context"), but flagged that this
"needs explicit scoping so a user's actual conversation history isn't
silently destroyed." Not built: the compactor/reviewer already operate on
session `.summary` fields, not raw `turns`, and no destructive trim was
specified precisely enough to implement without risking real conversation
history. Add if/when there's a concrete, reversible trimming rule to
implement.

### Verified

- `node-bot/test/server-routes.test.js`: 4 new tests on
  `/internal/idle-report` (below threshold, crosses threshold, debounced
  while continuously idle, re-fires after going active then idle again),
  using dependency-injected `triggerIdleConsolidation` and `getGamingStatus`
  so no real model call, file I/O, or dependence on what's actually running
  on the dev machine leaks into the test (the gaming-status check hits a
  real `tasklist` spawn otherwise — worth knowing if you see one of these
  tests fail locally while a watched game is genuinely open).
- 2 new tests for `formatMemoryMarkdown` (the pure markdown-rendering piece
  of `writeMemoryMarkdown`, split out specifically so it's testable without
  touching the module's live `BACKGROUND_MEMORY_META` state or disk).
- Full suite (`node run_tests.js`): all files pass.
- Manual idle-detection verification (leaving the machine idle for the
  configured threshold) is still the right way to confirm end-to-end
  behavior per the issue's acceptance criteria; not something an automated
  test can cover.
