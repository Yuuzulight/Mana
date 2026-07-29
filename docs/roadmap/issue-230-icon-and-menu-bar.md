# Issue 230: Fix broken taskbar/tray icon and remove native menu bar

## Status: Fixed and live-verified.

## Bugs found

1. **Taskbar and tray icon showed as blank/generic.** `createTray()`
   loaded `sprites/sprite-idle.png` -- a file deliberately deleted from the
   repo a while back (issue #45/#46 purged the whole `sprites/` folder for
   licensing reasons). `nativeImage.createFromPath()` doesn't throw on a
   missing file, it silently returns an empty image, which is why this
   never surfaced as a visible crash -- just a blank icon nobody
   investigated. The main window's `BrowserWindow` config had no `icon:`
   option at all, so it fell back to Electron's own default icon for both
   the taskbar entry and title bar.
2. **Native File/Edit/View/Window/Help menu bar showing.** Electron shows
   this by default unless `Menu.setApplicationMenu()` is explicitly called
   -- nothing in `main.js` ever called it. Not a regression, just never
   addressed.

## Fix

- Rasterized the existing Mana Crystal SVG (the same three-triangle design
  already used for the sidebar logo and startup screen -- see
  `renderer/index.html`) into a real PNG at `windows-launcher/assets/icon.png`,
  256x256, transparent background. Pure Node (`zlib` for PNG's DEFLATE
  stream, manual point-in-triangle rasterization with 4x4 supersampling
  for anti-aliasing) -- no browser round-trip or external dependency
  needed, since the artifact-preview browser tool treats files outside the
  active project folder (and arbitrary local dev servers) as locked-down
  static snapshots with scripting disabled.
- Added `APP_ICON_PATH` constant next to `ROOT_DIR`; `createWindow()`'s
  `BrowserWindow` options now pass `icon: APP_ICON_PATH`.
- `createTray()` now loads `APP_ICON_PATH` instead of the dead
  `sprites/sprite-idle.png` path.
- `Menu.setApplicationMenu(null)` added early in `app.whenReady()`.

## Verification

- `node --check` on `main.js`.
- Full `windows-launcher` test suite (12 files, sequential) -- no
  regressions.
- **Live, visual verification**: launched the real app, brought the actual
  window to the front via `SetWindowPos`/`HWND_TOPMOST` (not
  `SetForegroundWindow`, which Windows silently denies from a
  non-foreground caller -- confirmed the hard way: an earlier attempt using
  `SetForegroundWindow` captured whatever window actually was topmost,
  not Mana, since `CopyFromScreen` captures the composited screen contents
  regardless of which window a rect logically "belongs" to; un-topmosted
  immediately after capturing, not left pinned above the user's other
  windows), then captured just that window's own rectangle via
  `System.Drawing.Graphics.CopyFromScreen`. Confirmed visually: the
  titlebar shows the correct crystal icon, and the File/Edit/View/Window/
  Help bar is gone. Confirmed no "Tray icon unavailable" warning in the
  app's own log (the tray icon shares the exact same source file and
  loading call as the window icon, which was already visually confirmed
  correct) -- the resulting screenshot contained real prior conversation
  content from an existing session and was deleted immediately after
  inspection rather than kept.
