# Launcher UI polish: Mica look, welcome, Mana night, sharp text

From the mockups at https://claude.ai/artifact/GGG99sJHBP56jv3gdSEfWc (source `docs/plans/mana-window-styles.html` in the main checkout). Yuuzulight picked:

- **A**, soft glass, for the main window;
- **B**, the welcome in an empty chat (2026-11-06: she swapped it in for C, which was built and then removed);
- **D**, Mana night, for focus and long sessions;
- **F**, sharp text on every screen (2026-11-06: deferred to its own branch; her only monitor is at 100%). Her live avatar card and the full right rail stay in every design.

## How the Mica look is made

The textbook route is the system backdrop (`DWMWA_SYSTEMBACKDROP_TYPE`) with the frame extended into the client area. That needs every pixel to carry alpha. GDI text and native controls (ListView) don't, and the chat is GDI throughout. So the look is made the way Mica itself is made: the wallpaper, blurred and tinted.

- `WallpaperBackdrop` reads each monitor's wallpaper through `IDesktopWallpaper`: file, monitor rectangle, fit mode and background colour.
- It renders each wallpaper the way Windows lays it out, then keeps it as a small, heavily blurred bitmap (1/16 scale, about 60 KB a monitor). It rebuilds when the wallpaper or the displays change.
- `GlassSurface` draws, under the window, the slice of those bitmaps at the window's screen position, then the preset's tint. This replaces the painted glows.
  - It redraws after a move ends and on focus changes.
  - Unfocused, it draws the plain tint, as Mica does.
- **Falls back to her glows** when there's no wallpaper image (a solid colour), and when the setting is off.
- The window border takes her lavender (`DWMWA_BORDER_COLOR`, Windows 11).

Same memory and drawing cost as the glows: one window-sized background bitmap plus the list slices.

## Mana night (D)

- A second glass preset, `manaNight`: navy-violet tint, periwinkle text, her lavender accent.
- Glass fills, edges, sheen and buttons get dark variants.
- Offered in Settings beside "Mana". A rail button, Focus mode, switches to Mana night and puts the chat list away, then switches back; the saved theme isn't touched.

## Welcome (B)

- An empty chat opens on her: her live model moves from the sidebar card to the middle of the chat (waist framing), and the card steps aside, so she's never drawn twice.
- Under her: a greeting by the hour, a hint, and up to three cards. Two pick up the most recent chats; one puts "What did I miss today?" in the message box, to send or edit.
- The first message sends her back to the card.
- The launcher stores no name for the user, so the greeting has none.

## Sharp text (F)

- `ApplicationHighDpiMode` goes to `PerMonitorV2`.
- Every window scales its fixed pixel sizes by `DeviceDpi` and redraws on `DpiChanged`. The glass background, avatar card and caption strip re-render at the new scale.

## Polish from A, after the above

- Messages grouped, with a time on hover.
- Tool steps folded to one line (`ChatStepsStrip`).
- A Copy button on code blocks.
- One icon set (Segoe Fluent Icons, falling back to Segoe MDL2 Assets on Windows 10).
- One type scale (Segoe UI Variable).
- Pinned chats and unread dots, if the backend has them. Otherwise this is left out and noted.

## Checks

- Each piece gets unit tests where it has logic: wallpaper layout maths, tint, fold threshold, DPI scaling.
- An env-gated snapshot test (`MANA_WINDOW_SNAPSHOT_DIR`) renders the main window per preset, to look at.
- Targeted test files run locally; the full suite runs in CI.
