# Issue 624: Wire Existing Accessibility-Tree-First Extraction Into The Periodic Ambient Glance Loop, Add Pre-Storage PII Filtering

## Correction notice

A follow-up codebase audit (2026-09-12) found this issue's premise was
wrong: accessibility-tree-first extraction already exists and ships,
just on a separate code path from the periodic glance loop. Scope
narrowed to wiring the two together, plus the genuinely-missing PII
filter.

## Goal

Wire the existing accessibility-tree-first screen-reading path into the
periodic ambient glance loop, instead of building a new one, and add
PII/secret filtering before screen-derived text reaches long-term
memory.

## Why

The original research assumed "no accessibility-tree-first extraction
exists" anywhere in the codebase. That's false -- it exists, just isn't
connected to the loop this issue was actually trying to improve:

- **Accessibility-tree-first extraction already ships** (issue #343):
  `windows-launcher/accessibility-tree.js` + `readScreenContext()`
  (`renderer.js:2785-2836`) already tries
  `screen:read-accessibility-tree` first and only falls back to
  screenshot/OCR/vision on failure, timeout, or an empty tree. It's used
  by the conversational/keyword-triggered path
  (`screen-context-trigger.js`).
- **The periodic ambient glance loop doesn't use it**:
  `runScreenSensingGlance()` (`renderer.js:2877`), fired on a fixed
  `setInterval(..., SCREEN_SENSING_INTERVAL_MS)` (120s default), always
  calls `screen:capture-primary` directly and bypasses
  `readScreenContext()`'s tree-first logic entirely -- so the
  fixed-timer claim from the original research is correct, but the "no
  accessibility-tree-first extraction" claim was about the wrong code
  path.
- **No pre-storage PII/secret filter exists anywhere** -- this part of
  the original research holds and is unchanged.

## Proposed Scope

- Gate `runScreenSensingGlance()` on OS-level events (foreground-window
  change, input idle-to-active transition, clipboard change) instead of
  the fixed 120s timer.
- Route it through the existing `readScreenContext()`
  accessibility-tree-first path instead of calling
  `screen:capture-primary` directly, so it only falls back to a
  vision-model call when the tree is empty/unavailable (games, remote
  desktops) -- reusing #343's existing logic rather than reimplementing
  it.
- Add a lightweight local PII/secret pattern-matcher (regex plus a small
  classifier for card numbers, ID numbers, API keys/tokens) at the
  ingest boundary, before any screen/vision-derived text is written into
  the memory graph or consolidated by Dream Mode.

## Acceptance Criteria

- `runScreenSensingGlance()` no longer runs on a fixed timer; it's
  demonstrably gated on real OS-level activity events.
- The periodic glance loop uses the same accessibility-tree-first path
  as the conversational trigger (`readScreenContext()`), confirmed by a
  measured reduction in vision-model invocations for a normal usage
  session.
- A documented case where a stray secret/PII pattern visible on screen
  (e.g. a terminal API key) is caught and excluded before reaching
  long-term memory.

## Related

Issue #343 (accessibility-tree-first extraction, already shipped on the
conversational path). `docs/roadmap/oss-inspiration-survey-2026-09.md`.
