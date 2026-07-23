# Local Data Storage And Uninstalling (desktop-client)

Where Mana's local data lives, and what happens to it when you uninstall.
See [issue #121](https://github.com/Yuuzulight/Mana/issues/121) for the
full investigation.

## Where data lives

Packaged `desktop-client` installs store local data (chat/session memory,
saved sign-in, presets, the job-application tracker, paired mobile devices,
pending file-write approvals, talk budget) under:

```text
%APPDATA%\Mana\node-bot-data\
```

This is the standard per-user Electron data directory
(`app.getPath('userData')`), not inside the app's own install directory --
deliberately, so it survives reinstalls and updates, and so a normal
uninstall doesn't wipe it out from under you.

Running node-bot directly from the source tree (`npm start` in either
`windows-launcher` or a dev `desktop-client`) is unaffected -- it still uses
`node-bot/data/` in the repo, same as always. The relocation only applies
to packaged builds (`app.isPackaged`), wired from `desktop-client/main.js`.

## Why this changed

Previously, every node-bot data store defaulted to writing inside its own
directory (`node-bot/data/`), which for a packaged app is bundled inside
the install directory via `extraResources`. A normal NSIS uninstall deletes
the entire install directory -- meaning uninstalling Mana used to silently
delete all local data, every time, with no prompt and no way to keep it.

## Migrating existing data

The first time a packaged build starts after this change, if
`%APPDATA%\Mana\node-bot-data\` doesn't exist yet but the old
in-install-dir location does, its contents are copied (not moved) into the
new location automatically -- see `desktop-client/data-dir-manager.js`. The
old copy is left in place as a safety net; it just stops being read/written
once the new location has data.

## Uninstalling

The uninstaller now has an extra page: "Also delete my Mana data" (a
checkbox, unchecked by default). Leave it unchecked to keep your data for
next time; check it to have `%APPDATA%\Mana\node-bot-data\` removed as part
of the uninstall. See `desktop-client/build/installer.nsh`.
