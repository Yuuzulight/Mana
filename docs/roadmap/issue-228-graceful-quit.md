# Issue 228: Graceful quit with a closing progress screen

## Status: Built and live-verified.

## Background

Prompted by the UI-reference artifact work for issues #219/#226: real quit
behavior in `windows-launcher` was silent and instant --

```js
app.on("quit", () => {
  if (backendProcess) { try { backendProcess.kill(); } catch (e) {} }
  // ...same for ttsProcess, retrieverProcess, fallbackKokoroProcess,
  // searxngProcess, embedderProcess
});
```

No progress shown, and structurally there was nowhere to show any even if
it wanted to -- `"quit"` is a late Electron lifecycle event that fires
after windows are already closed/destroyed.

**`desktop-client` already had this exact feature, fully built and
shipped** -- discovered while researching how to build it here:
- `desktop-client/service-manager.js`: `stopBackendAndLlama()` (graceful
  `POST /admin/shutdown` to node-bot, releases llama-server's VRAM/RAM
  before it exits) + `stopChild()` (kill + bounded wait) + `stopAll()`.
- `desktop-client/main.js`: intercepts the window's own `close` and
  `before-quit`, runs the graceful sequence, races it against a 15s
  overall timeout, then `app.exit(0)`.
- `desktop-client/renderer/index_fixed.html` + `renderer.js`: a
  `#shutdownOverlay` reusing the exact same `.startup-*` classes/layout as
  the boot screen, in reverse.

This issue ports that pattern to `windows-launcher`, adapted to its own
process set and its own startup screen's row shape (`backend`/`voice`/
`websearch`/`localai` -- generic capability names, not literal service
names like desktop-client's `backend`/`kokoro`/`searxng`/`llama`).

## Two real pre-existing bugs found and fixed along the way

1. **`desktop-client/main.js`** passed `process.env.ADMIN_SECRET` as the
   bearer token for `/admin/shutdown` -- node-bot's actual env var (per
   `server.js`'s `checkAdminAuth`) is `MANA_ADMIN_SECRET`.
   `process.env.ADMIN_SECRET` is never set by anything, so any user who
   actually configured `MANA_ADMIN_SECRET` got a silent 401 on every
   graceful-shutdown attempt and fell back to the 8s-timeout hard-kill
   path every time. `checkAdminAuth` only allows unauthenticated requests
   through when no secret is configured at all, which is why this never
   surfaced. Fixed: now reads `MANA_ADMIN_SECRET`.
2. **`windows-launcher/main.js`**'s own old `app.on("quit", ...)` handler
   referenced `fallbackTtsProcess` -- a variable never declared anywhere
   in the file. Reading it (not just assigning) throws a `ReferenceError`
   the moment that line executes, which crashed the handler partway
   through and meant `retrieverProcess`/`fallbackKokoroProcess`/
   `searxngProcess`/`embedderProcess` -- everything after that line --
   never actually got killed via this path. Fixed by removing the bogus
   reference; that handler is kept as a last-resort safety net for any
   quit path that somehow bypasses the new graceful flow below.

## Design

- Reuses the existing `#startupOverlay`/`#startupTitle`/`#startupSubtitle`/
  `.startup-row` markup (issue #138) rather than a parallel second overlay
  -- swaps title/subtitle/row text into "closing mode" via new
  `shutdown-begin`/`shutdown-progress` IPC events, instead of
  `startup-progress`/`startup-complete`.
- Reuses windows-launcher's own 3-state status vocabulary (`starting`/
  `ready`/`timeout`, already styled in CSS) rather than importing
  desktop-client's separate `failed`/`skipped` states -- no new CSS
  needed. Renderer maps status to text: `ready` -> "Stopped", `timeout` ->
  "Force-stopping", otherwise "Stopping...".
- `backend` + `localai` rows (`stopBackendAndLocalAi()`): one graceful
  `POST /admin/shutdown` call + wait for `backendProcess` to exit,
  reported as two rows since the startup screen already splits
  Backend/Local AI the same way.
- `voice` row (`stopRow("voice", "Voice", [ttsProcess,
  fallbackKokoroProcess])`): kill + wait for whichever of the primary TTS
  process or its Kokoro fallback is actually running -- windows-launcher
  can have more than one process behind a single row, unlike
  desktop-client's one-process-per-row shape.
- `websearch` row: kill + wait for `searxngProcess`.
- `retrieverProcess`/`embedderProcess`: killed alongside backend with no
  dedicated row, matching that they have no row on the startup screen
  either.
- Intercepts both `mainWindow`'s own `close` event (the real X-button/
  native-close path today) and `before-quit` (covers the tray's "Quit"
  item and `window-all-closed`, which call `app.quit()` directly without
  a window close first) -- `before-quit` alone fires too late for the
  native-close path specifically, since the window would already be
  destroyed by the time it runs.
- If the window was minimized to the tray overlay when quit is triggered,
  `runGracefulShutdown()` lowers `setMinimumSize` back to the startup card
  size, resizes, centers, and shows the window (mirroring the reverse of
  the startup->main transition), and hides the floating avatar overlay
  window so it doesn't float on top of the closing screen.
- Bounded overall timeout (15s, matching desktop-client) races the whole
  `Promise.all` of per-row work; if it fires, force-kills `backendProcess`
  and proceeds anyway so a hung process can't leave the app stuck open.
- A 400ms grace period before `app.exit(0)` so the closing screen's final
  state (all rows resolved) actually gets a frame to render, instead of
  the window vanishing the instant the last IPC message is sent.

## Verification

- `node --check` on all touched files.
- Full `windows-launcher` test suite (12 files, sequential) -- no
  regressions. No new unit tests added: `main.js` has no existing
  precedent for direct unit testing (tightly coupled to Electron APIs,
  same as `registerInterruptHotkey()` from issue #219), verified via
  `node --check` + live testing instead, matching that precedent.
- **Live end-to-end test**: launched the real app
  (`HIDE_MAIN_WINDOW_AFTER_STARTUP=0` to keep the main window visible),
  confirmed its real size (1020x720), then sent a real `WM_CLOSE` message
  to the actual window handle via a Win32 `PostMessage` call (simulating
  a genuine X-button click, not a synthetic/mocked event) --
  confirmed via the process's own log output that the graceful sequence
  actually ran: `Node server exited with code 0` (node-bot's own graceful
  exit from `/admin/shutdown`, not a crash/force-kill code), `TTS service
  exited with code null` (Kokoro killed and exited), then the whole
  process terminated cleanly within a few seconds -- no "Overall shutdown
  timed out" warning, well under the 15s budget. Confirmed no orphaned
  Mana processes remained afterward.

## Out of scope

- Fixing the underlying "Windows can't deliver a catchable SIGTERM"
  limitation itself -- the graceful-HTTP-call-plus-bounded-wait-plus-
  force-kill pattern is the existing accepted workaround (already shipped
  in desktop-client), not something to redesign here.
- Any `desktop-client` changes beyond the one-line `ADMIN_SECRET` ->
  `MANA_ADMIN_SECRET` fix.
