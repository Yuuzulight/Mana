# Issue 138: windows-launcher UI Overhaul

## Goal

Bring `windows-launcher`'s renderer UI up to par with (and in some places
beyond) the patterns already shipped in `desktop-client`'s recent reskin.

## Why

`desktop-client` already had a popup info-bubble pattern for its info-only
nav items, a redesigned Doctor view, and a startup loading screen (see
`3cf5bb6` and PR #134) -- `windows-launcher` (the actually-supported
daily-use launcher per the README) had none of it: nav items swapped an
always-visible inline sidebar panel, Doctor was a cramped vertical list,
there was no startup feedback at all, and Settings had no Logs section and
no real Plugins UI.

## Status: Implemented

- **Nav info popup**: clicking Avatar, Web access, Vision, Model, or Doctor
  now opens a popup (`#navInfoModal`, reusing the existing
  `.modal-overlay`/`.modal`/`.modal-header` shell already used by
  memoryModal/confirmModal) instead of an always-expanded inline panel.
  Sessions/Market watch/Settings stay regular inline panels. The panel
  content divs kept their original element ids, just relocated in the DOM,
  so all existing renderer.js logic (avatar zoom, web access status
  polling, vision hotkey button, model controls) works unchanged.
- **Doctor redesign**: shows a pass/warn/fail pill summary, then a
  "Needs attention" chip grid (name + colored dot only) and an "All good
  (N)" chip grid for the rest, reusing `doctor-panel.js`'s existing
  `formatDoctorPanel` output shape untouched. Clicking a chip opens a small
  popover (`#doctorBubble`, `position:fixed`) with that check's detail
  message.
- **Mana Crystal logo**: swapped the sidebar's plain single-triangle
  `⛰` glyph for the same 3-facet diamond SVG `desktop-client` uses, reused
  again in the startup screen.
- **Startup loading screen**: the window now shows immediately on launch
  with a loading overlay (crystal logo + per-service progress: Backend,
  Voice, Web search, Local AI) instead of just appearing or staying hidden
  with no feedback. Driven by new `main.js` plumbing
  (`reportStartupProgress`/`pollUntilReady`/`runStartupSequence`) that polls
  each service's existing `isXRunning()` health check, bounded by a 25s
  overall timeout so a stuck/unmanaged service can't hang the screen
  forever. Once done, the window either reveals the chat UI or hides into
  avatar-only mode per the existing `HIDE_MAIN_WINDOW_AFTER_STARTUP` flag
  (previously read at window-creation time; now applied after startup
  actually finishes).
- **Settings additions**:
  - **Logs**: a `#backendLogs` tail, streamed from `backendProcess`
    stdout/stderr over a new `backend-log` IPC channel, with a 500-line
    ring buffer (`get-backend-log`) so opening Settings well after launch
    still shows recent history.
  - **Plugins**: `#pluginsPanel` lists every plugin from the existing
    `GET /plugins` route, grouped under category headers, with a search
    box that filters by name/description, the existing enable/disable
    toggle (`POST /plugins/:key/enabled`), and an "+ Add" button that opens
    `plugins/README.md` (no plugin marketplace/installer -- out of scope).

### Real bugs found and fixed during live verification

- **A `const doctorBubbleEl` redeclared across `renderer.js` and
  `sidebar-nav.js`** -- both classic `<script>` tags share one global
  lexical scope (already relied on elsewhere in this file), so the second
  declaration was a `SyntaxError` that silently killed all of
  `sidebar-nav.js`'s execution, including `switchSidebarPanel` -- every nav
  click did nothing. Caught via a live console-exception capture over CDP;
  `node --check` doesn't catch this class of bug since each file parses
  fine on its own.
- **Startup-overlay race condition**: the overlay's own `hidden` state was
  driven solely by a one-shot `startup-complete` IPC event. If every
  service was already ready before the renderer's listener attached (e.g.
  services still warm from a previous launch -- reproduced live, not
  hypothetical), that event fired and was missed with nothing left to
  replay it, so the overlay never hid despite every row showing "Ready".
  Fixed by deriving "done" client-side from the tracked row states instead
  of trusting the one-shot event alone.
- **A large blank gap above the Doctor popup's content**: `.modal-body`'s
  shared `white-space: pre-wrap` (needed by `memoryModal`, which displays
  raw preformatted text) was also applying to the new `#navInfoBody`, which
  holds structured HTML -- `pre-wrap` doesn't collapse the literal
  indentation/newlines between HTML tags in the source, rendering them as
  real blank lines. Scoped `white-space: normal` to `#navInfoBody`
  specifically rather than touching the shared rule.

### Deliberate simplifications

- `ponytail:` Doctor's "Local AI" startup row reports ready immediately
  unless `MANA_EAGER_LLAMA_SERVER=1` -- llama-server is lazy-started on the
  first chat message by default, so there's nothing to wait for; blocking
  on it would hang the loading screen on a service that was never asked to
  start.
- The startup "Voice" check treats either the configured TTS provider *or*
  its Kokoro fallback as ready, since fish/chatterbox/gpt_sovits all fall
  back to Kokoro if their primary never comes up -- otherwise the default
  `fish` setup (whose server isn't launcher-managed; see
  `docs/fish_speech_tts.md`) would wait the full 25s timeout on every
  launch.
- `desktop-client`'s own Plugins list still isn't category-grouped/
  searchable -- out of scope here per the issue (`windows-launcher` was the
  target; porting the same treatment back to `desktop-client` is a
  follow-up, not blocking).

### Verified

- Full `windows-launcher` suite (`node --test test/*.test.js`, one file at
  a time): 62/62 pass, no regressions (`doctor-panel.js` itself was never
  touched -- only how its output is rendered).
- Live, end-to-end over Chrome DevTools Protocol against the real running
  app (`--remote-debugging-port`, `Page.captureScreenshot` +
  `Runtime.evaluate`, not a mock): startup overlay shows and correctly
  hides itself; crystal logo renders in the sidebar; clicking each of the
  5 popup nav items opens `#navInfoModal` with the right title and closes
  via the X button; Doctor popup renders real pass/warn/fail counts (14
  passing / 4 need attention / 0 failing on this machine) with working
  chip-click detail bubbles; Settings' Plugins section renders real
  category-grouped data from the backend (2 categories, 2 toggles) with a
  working search filter (4 rows -> 1 on a query -> 4 again on clear); Logs
  section shows real streamed backend output (confirmed non-empty,
  containing actual startup log lines).
