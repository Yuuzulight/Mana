# Issue 232: Packaged .exe/installer had no app icon configured

## Status: Fixed.

## Background

Issue #230 fixed the *runtime* window/tray icon (the `BrowserWindow` `icon:`
option and `nativeImage.createFromPath()` used by the Tray). That's a
completely separate code path from the *packaged* app icon, which is
controlled by electron-builder's `build.icon` config and determines the
compiled `.exe`'s icon, the Start Menu tile, Explorer's icon for the file,
and the NSIS installer icon.

Neither app had this configured:

- `windows-launcher/package.json` had no `build` section at all -- it was
  never set up for packaging in the first place (`pack`/`dist` scripts
  existed but had nothing telling electron-builder about the icon, appId,
  or output target).
- `desktop-client/package.json` already had a full `build` section (appId,
  publish config, NSIS installer settings, extraResources) since it's the
  actively-released app, but it had no `icon` key either, and its `build/`
  folder only contained `installer.nsh` -- no icon file existed anywhere in
  the repo at packaging resolution.

Both would have silently fallen back to Electron's generic default icon for
the compiled binary.

## Fix

- Added `windows-launcher/build/icon.png` and `desktop-client/build/icon.png`
  -- both the same 512x512 transparent PNG of the Mana Crystal design
  (higher resolution than the 256x256 runtime icon from #230, for cleaner
  Start Menu tile scaling). electron-builder auto-generates the
  multi-resolution `.ico` electron-builder/NSIS needs from a single square
  PNG >=256x256, so no hand-rolled `.ico` was needed.
- Added a `build` section to `windows-launcher/package.json`:
  `appId`, `productName`, `directories.buildResources`, `icon`, and a
  `win.target: ["nsis"]` -- it had none of this before, so the whole
  section is new.
- Added `"icon": "build/icon.png"` to `desktop-client/package.json`'s
  existing `build` section (its other packaging config was already
  correct and is untouched).

## Verification

- `node -e "JSON.parse(...)"` on both `package.json` files.
- `node --check` on `windows-launcher/main.js` (untouched by this fix, but
  re-confirmed clean since it's the only other file touched this session).
- Full `windows-launcher` test suite (12 files, sequential) -- no
  regressions.
- Not verified: actually running `electron-builder`/`npm run dist` to
  confirm the packaged `.exe` visually shows the icon. This is a config
  change directly modeled on desktop-client's own already-working pattern
  (appId/publish/nsis config), and a full packaging run produces real
  installer artifacts and takes several minutes -- deferred rather than run
  speculatively. Worth doing before the next real release build.
