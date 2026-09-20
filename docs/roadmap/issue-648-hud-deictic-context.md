# Issue 648: Add Positional/Deictic Screen-Context Resolution ("This", "Here")

## Goal

Let a deictic reference ("this," "here," "read that") resolve to whatever
is under the avatar/cursor on screen, instead of requiring the user to
name the window or app explicitly every time.

## Why

Hermes Desktop's HUD mode (`Cmd/Ctrl+Shift+H`) detaches its chat into a
chrome-free, always-on-top floating bar. Idle, it fades to a slim strip
and is click-through glass (clicks pass to the app underneath); typing
wakes it. The core mechanic: **the bar's on-screen position is itself the
context** — wherever it's parked, "this"/"here"/"that page" resolve to
whatever's underneath it, with no explicit window reference needed.

Verified missing in Mana across all three relevant pieces:
- `windows-native-launcher/ScreenContextTrigger.cs` gates screen reads on
  a fixed keyword list in the transcript only (`"screen"`, `"look"`,
  `"see"`, etc.) — no positional signal factors in at all.
- `windows-native-launcher/ScreenContextReader.cs` has no cursor-position
  or window-under-point logic anywhere (`WindowFromPoint`,
  `Cursor.Position` — zero matches).
- `QuickEntryForm.cs` and `AvatarOverlayForm.cs` (Mana's closest analogs
  to a HUD bar) are both `TopMost` but neither has
  click-through-when-idle behavior.

## Proposed Scope

Not a straight port — Mana already has a persistent avatar overlay, which
is a better anchor for this than a second floating HUD bar:

- Feed the avatar overlay's current screen position (and/or cursor
  position at the moment of a spoken/typed command) into
  `ScreenContextReader` as an additional signal, layered on top of the
  existing keyword gate rather than replacing it.
- When a deictic reference is detected in a command and the keyword gate
  would trigger a screen read anyway, prefer reading the window/region
  under the avatar or cursor over the plain foreground window.
- Optional, smaller follow-up: give `QuickEntryForm` click-through-when-
  idle + fade behavior similar to Hermes' HUD bar, since Mana already has
  the always-on-top piece.

## Acceptance Criteria

- A command like "what's this" or "read that," spoken or typed while the
  avatar overlays a specific window/region, resolves the screen-read to
  that region rather than only the generic foreground window.
- No regression to the existing keyword-gated screen-read behavior for
  non-deictic commands.

## Related

`docs/roadmap/hermes-desktop-eval-2026-09.md`. Sibling to issue #624
(wiring accessibility-tree extraction into the ambient glance loop) —
same subsystem, one more signal for *what* to read.
