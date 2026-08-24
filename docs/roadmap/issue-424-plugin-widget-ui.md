# Issue 424: Sandboxed Plugin Widget UI

## Goal

Let a plugin ship its own iframe-sandboxed widget UI, not just backend
logic and chat-context injection.

## Why

Inspired by AIRI's Gamelet API (`plugin.airi.json` manifest format,
reference example: a chess gamelet). Mana's `plugins/` system is
backend-only today. See `docs/roadmap/oss-inspiration-survey-2026-08.md`.
Bigger architectural lift than most survey items -- scoping now as a
pattern, not committing to build ahead of a plugin that actually needs it.

## Proposed Scope

- Define a manifest format for a plugin to declare an iframe-sandboxed
  widget.
- Add a rendering slot in the launcher UI that activates when a plugin
  with a widget is enabled.
- Keep it fully opt-in per plugin; existing backend-only plugins are
  unaffected.

## Acceptance Criteria

- A plugin can declare a widget in its manifest and have it render
  sandboxed in the launcher when enabled.
- Plugins without a widget declaration behave exactly as before.
- No plugin widget can access anything outside its sandbox without an
  explicit, whitelisted bridge.
