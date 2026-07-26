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

- **Nav info popup, then everything-is-a-popup**: this went through three
  rounds of iteration. First, Avatar/Web access/Vision/Model/Doctor opened
  in a popup (`#navInfoModal`, reusing the existing
  `.modal-overlay`/`.modal`/`.modal-header` shell already used by
  memoryModal/confirmModal) while Sessions/Market watch/Settings stayed
  inline. Then those five moved to live *inside* Settings (a
  `#settingsInfoNav` row of the same nav-items, nested). Finally, Market
  watch and Settings themselves became popups too -- Sessions is now the
  only persistent inline panel; everything else opens in the single shared
  modal and closes (X, backdrop click, or Escape) back to Sessions. Market
  watch's standalone UI (a bespoke item-lookup form hitting `/ffxiv/market`)
  was removed outright rather than also turned into a popup: it duplicated
  the "FFXIV Market & Crafting" entry already in Settings > Plugins, which
  is `defaultEnabled: false` there -- one off-by-default toggle instead of
  two different UIs for the same data. The panel content divs kept their
  original element ids throughout, just relocated in the DOM, so all
  existing renderer.js logic (avatar zoom, web access status polling,
  vision hotkey button, model controls) works unchanged.
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
- **The in-window Live2D avatar's PixiJS renderer could get initialized at
  a broken size**: `initWindowAvatar()` ran unconditionally at script load,
  reading `manaCanvasEl.clientWidth/clientHeight` at that moment to size
  PixiJS -- but the window now opens small (see the startup screen below)
  and only grows to full size once startup finishes, and `live2d-avatar.js`
  has no `resize()` to call afterward if the initial measurement was wrong.
  Deferred the call to `handleStartupComplete()` (guarded so it only ever
  runs once, whichever of the three completion paths -- live event, catch-up
  snapshot, or the race-condition fix above -- fires first), and reordered
  `runStartupSequence()` in main.js to resize the window *before* sending
  the IPC signal, so the renderer never measures the canvas at the small
  size. Separately investigated a real user report that the avatar "cannot
  be seen": confirmed unrelated to this branch (identical blank canvas via
  direct pixel readback on an unmodified checkout of `main`, before this
  session's changes), and ultimately inconclusive as a real bug at all --
  a subsequent live screenshot showed the avatar rendering correctly, and
  the earlier "blank canvas" reads were most likely `readPixels()` without
  `preserveDrawingBuffer` returning stale/cleared buffer contents rather
  than reflecting an actual empty frame. Not chased further since it
  predates and is out of scope for this issue either way.

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
  app (`--remote-debugging-port`, `Runtime.evaluate` for interaction,
  `Page.captureScreenshot` where occlusion allowed it, `PrintWindow` with
  `PW_RENDERFULLCONTENT` as a fallback when the real desktop window was
  covered by other windows -- not a mock either way): startup overlay
  shows and correctly hides itself; the window opens at its small
  startup-card size and grows to full size once startup completes; crystal
  logo renders in the sidebar; top-level nav is exactly Sessions and
  Settings (confirmed no `marketWatch` string anywhere in the DOM); Doctor
  popup renders real pass/warn/fail counts with working chip-click detail
  bubbles; opening Settings then Doctor from `#settingsInfoNav` correctly
  swaps the *same* modal's title/content; closing any popup (X button,
  simulated backdrop click, Escape) lands back on Sessions with its
  nav-item marked active and its panel visible again, not a blank sidebar;
  Settings' Plugins section renders real category-grouped data from the
  backend with a working search filter; Logs section shows real streamed
  backend output.
