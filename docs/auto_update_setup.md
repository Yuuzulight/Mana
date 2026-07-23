# Auto-Update (desktop-client)

`desktop-client` checks GitHub Releases for a newer version on startup and
whenever you click **Check for Updates** in Settings. See
[issue #120](https://github.com/Yuuzulight/Mana/issues/120).

## What it does (and doesn't do)

- On startup (packaged builds only -- disabled when running `npm start` in
  dev), it silently checks for an update. If one exists, you get a dialog:
  **Download** or **Not now**. Nothing downloads without that click.
- After a download finishes, a second dialog asks **Restart now** or
  **Later** before anything is installed. `autoDownload` and
  `autoInstallOnAppQuit` are both off in `update-manager.js` specifically so
  neither step can happen without you clicking through it.
- A startup check failing (offline, GitHub hiccup) fails silently -- no
  error dialog. Clicking **Check for Updates** manually always shows the
  result, including failures.
- Set `MANA_AUTO_UPDATE_ENABLED=0` to disable update checks entirely.

## Cutting a release that the updater can actually find

`npm run dist` (in `desktop-client`) now also writes `dist/latest.yml`
alongside the installer -- this is the feed file electron-updater fetches
from the release to know a new version exists and where to get it.
**Both files need to go on the GitHub Release**, not just the installer:

```powershell
cd desktop-client
npm run dist
gh release create vX.Y.Z "dist/Mana-Setup-X.Y.Z.exe" "dist/latest.yml" --title "..." --notes "..."
```

If you only upload the `.exe`, existing installs will never detect the
update -- there's nothing for them to check against.

`artifactName` is pinned to `Mana-Setup-${version}.${ext}` in
`package.json`'s `build` config specifically so the file electron-builder
writes to `dist/` always matches the filename `latest.yml` expects
(electron-builder's un-pinned default artifact name has spaces, e.g. `Mana
Setup 0.2.1.exe`, which doesn't match what `latest.yml` writes as the
expected download URL -- verified by building both ways).

## Known caveat until issue #119 lands

The installer is currently unsigned, so both the initial install *and*
every downloaded update still trigger the same SmartScreen "Unknown
Publisher" warning. Auto-update still works mechanically without signing on
Windows/NSIS, but the warning won't go away until code signing is set up
(see [docs/code_signing_setup.md](code_signing_setup.md)).
