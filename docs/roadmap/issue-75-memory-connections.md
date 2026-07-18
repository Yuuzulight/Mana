# Issue 75: Cross-Session Memory Connections in Dream Mode Consolidation

## Goal

During idle-triggered consolidation (#69), add a distinct pass that finds
and records *connections* between separate memories/sessions, not just
compaction.

## Why

Mana's existing `runBackgroundCompactor`/`runBackgroundReviewer` compact and
prune session summaries, but never connect separate sessions to each other
-- a session revisiting an earlier topic days later has no record linking
the two.

## Status: Implemented

- **`runBackgroundConnections()`** (`node-bot/server.js`, alongside the
  existing compactor/reviewer inside the same idle-gated block): reads the
  same numbered per-session summaries `runBackgroundReviewer` already reads
  via `asyncLoadBackgroundMemory()`, and asks the model to find real
  relationships between them -- format: `Summary #1 <-> Summary #3: <short
  reason>`. Replies with exactly `NONE` when there's nothing real to
  connect (so a set of unrelated one-off sessions produces no noise).
- **Skipped on noise**: requires at least `MANA_BACKGROUND_CONNECTIONS_MIN_SUMMARIES`
  (default 2) processed summaries before even attempting a connections pass
  -- matches the acceptance criteria's "skip when there isn't enough
  session history" requirement.
- **Bounded cost**: capped at the `MANA_BACKGROUND_CONNECTIONS_MAX_SUMMARIES`
  (default 30) most-recent summaries, and the model is asked for at most 5
  connection lines.
- **Own MEMORY.md section**: `formatMemoryMarkdown(compacted, facts,
  connections)` gained a third parameter rendering a distinct `##
  Connections` section, kept separate from `## Summary` and `## Key Facts`
  so a later compaction pass can't silently merge or drop what the
  connections pass found.
- **Same idle/gaming-pause gating as #69, for free**: wired as a third step
  inside the existing `triggerIdleConsolidation()` (right after the
  compactor and reviewer), so it inherits the exact same idle-threshold
  debounce and `getGamingStatus().gamingAppRunning` pause with zero new
  gating code.
- Exposed via the same `runBackgroundConnectionsPublic` hoisting pattern
  already used for the compactor/reviewer, so it's reachable from the idle
  trigger without needing `app`/route access inside the gated startup IIFE.

### Real-model verification

Like the compactor/reviewer this extends, `runBackgroundConnections()`
lives inside the module's test-disabled startup IIFE (see the
`NODE_ENV`/`NODE_TEST_CONTEXT` guard) and isn't reachable via dependency
injection the way the idle-report route's top-level trigger is -- matching
the existing, already-accepted pattern for this subsystem (neither the
compactor nor reviewer has direct unit-test coverage either; their own
admin preview/apply routes have none). The acceptance criteria itself asks
for a real-example verification, so that's what was done: the exact
connections prompt run against the real local model
(`Qwen3-4B-Q4_K_M.gguf`) with two synthetic summary sets.

**Two summaries sharing a topic** (FFXIV Weaver crafting, discussed in
summary #1 and revisited in summary #3, with an unrelated summary #2 in
between):

> Summary #1 <-> Summary #3: both discuss the FFXIV Weaver crafting
> rotation.

Correctly references both #1 and #3, skipping the unrelated #2 -- exactly
the issue's acceptance criterion.

**Unrelated one-off summaries** (banana bread recipe, weekend weather):

> NONE

No connection reported -- correct, since there wasn't one.

### Verified

- `node-bot/test/server-routes.test.js`: 2 new tests for
  `formatMemoryMarkdown`'s connections parameter -- omitted when empty,
  rendered in its own section (distinct from and after Key Facts) when
  present.
- Real-model verification above (connected-topic and unrelated-topic
  cases).
- Full suite (`node run_tests.js`): all files pass, no regressions.
