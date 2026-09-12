# Issue 624: Make The Ambient Vision Loop Event-Driven With Accessibility-Tree-First Extraction And Pre-Storage PII Filtering

## Goal

Cut the resource cost and privacy risk of Mana's ambient screen/vision
awareness loop.

## Why

Screenpipe (open-source, local-first, MIT) is the closest architectural
analog to Mana's ambient glance loop and makes two changes that both look
directly applicable:

- **Event-driven capture, not polling**: instead of a fixed-interval
  timer, it hooks OS-level signals (app switch, click, typing pause,
  scroll) and only captures/processes a frame when something meaningfully
  changed -- cutting both storage and, more importantly for Mana, the
  number of expensive local vision-model calls needed. Reported disk
  savings alone were roughly 6-7x versus naive continuous capture.
- **Accessibility-tree-first, OCR/vision-as-fallback**: it prefers the OS
  accessibility tree (structured button/label/field text the OS already
  exposes) over pixels, only falling back to OCR or a vision model when
  accessibility data isn't available (remote desktops, games, some
  non-native UI). A Windows UI Automation read is far cheaper than a
  local vision-model call on a screenshot.

Separately, Microsoft's Recall (and the general Purview-style DLP pattern
behind it) filters PII (passwords, government IDs, card numbers) on
extracted text *before* it's committed to any persistent/semantic index
-- not at query/output time, since a value already embedded and stored
can leak even if a later response is filtered. Mana's memory graph and
Dream Mode consolidation likely ingest screen/vision-derived text, which
is exactly the kind of data that can accidentally capture a stray API key
or password field during a coding or admin session.

## Proposed Scope

- Gate the ambient glance loop on OS-level events (foreground-window
  change, input idle-to-active transition, clipboard change) instead of a
  fixed timer.
- Try Windows UI Automation / accessibility APIs first for "what's on
  screen"; only invoke the vision model when accessibility text is
  insufficient or unavailable (e.g. games).
- Add a lightweight local PII/secret pattern-matcher (regex plus a small
  classifier for card numbers, ID numbers, API keys/tokens) at the ingest
  boundary, before any screen/vision-derived text is written into the
  memory graph or consolidated by Dream Mode.

## Acceptance Criteria

- The ambient glance loop no longer runs on a fixed timer; it's
  demonstrably gated on real OS-level activity events.
- A measured before/after reduction in vision-model invocations for a
  normal usage session (e.g. general desktop use, coding, browsing).
- A documented case where a stray secret/PII pattern visible on screen
  (e.g. a terminal API key) is caught and excluded before reaching
  long-term memory.

## Related

`docs/roadmap/oss-inspiration-survey-2026-09.md` (full research backing).
