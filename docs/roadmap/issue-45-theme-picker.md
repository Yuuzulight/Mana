# Issue 45: Add a Theme Picker UI Using Existing CSS Custom Properties

## Status

Implemented. `windows-launcher/renderer/theme.js` defines three built-in
presets (Violet — the existing default, Neutral dark, and Light) as sets of
values for the `:root` custom properties `index.html` already used
(`--bg`, `--panel`, `--panel-2`, `--border`, `--text`, `--muted`, `--accent`,
`--user-bubble`, `--mana-bubble`), plus a manual accent-color override on top
of whichever preset is active. The theme is persisted to `localStorage` and
applied as early as possible (a `<script>` in `<head>`, before `<body>`) to
avoid a flash of the default theme on launch. A "Theme" panel in the existing
System status & tools section offers preset buttons and a color input; no
other CSS changed, since every existing element already read these tokens.

## Goal

Let users choose or customize Mana's color theme, building on the CSS
custom-property tokens (`--bg`, `--accent`, `--border`, etc.)
`windows-launcher` already uses.

## Why

Inspired by odysseus's token-based theming (`theme.js` overriding
`--bg`/`--fg`/`--accent`/`--border`). `windows-launcher/renderer/index.html`
already defines `:root` custom properties for exactly this purpose — there's
just no picker UI yet.

## Proposed Scope

- Add a "Theme" panel/menu offering a few built-in presets (e.g. current
  purple, a dark neutral, a light mode) plus manual override of the accent
  color.
- Persist the selected theme (localStorage or a settings file) across
  launches.
- Apply theme via the same `:root` custom-property mechanism already in
  use — no structural CSS rework needed.

## Acceptance Criteria

- Users can switch between at least 2 built-in themes without restarting
  Mana.
- The selected theme persists across app restarts.
- Existing UI elements (buttons, avatar stage, chat bubbles) all respect
  the active theme's tokens.
