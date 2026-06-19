# PNG avatar setup

Mana can show a simple PNG-style avatar overlay on the bottom-left of the primary monitor.

The overlay is:
- transparent
- always on top
- click-through
- positioned just above the Windows taskbar
- switched to `talking` while Mana's reply audio plays

## Default assets

The default placeholder files are:

```text
windows-launcher/assets/avatar/idle.svg
windows-launcher/assets/avatar/talking.svg
```

You can replace them with your own art.

## Use PNG files

Put your PNG files here:

```text
windows-launcher/assets/avatar/idle.png
windows-launcher/assets/avatar/talking.png
```

Then update:

```text
windows-launcher/avatar/renderer.js
```

Change the `states` paths from `.svg` to `.png`.

## Position and size

The avatar defaults to:

```text
width: 260
height: 320
margin: 12
```

You can override those before starting Mana:

```powershell
$env:MANA_AVATAR_WIDTH = "320"
$env:MANA_AVATAR_HEIGHT = "420"
$env:MANA_AVATAR_MARGIN = "16"
```

Mana positions the avatar from the primary display work area, so it should sit above the taskbar rather than behind it.

## Current behavior

- Idle image shows when Mana is not speaking.
- Talking image shows while the TTS reply audio is playing.
- The overlay does not capture mouse input.
- The overlay closes when the main Mana window closes.
