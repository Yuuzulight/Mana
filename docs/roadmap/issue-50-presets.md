# Issue 50: Add Saved Prompt/Behavior Presets

## Goal

Let users save and switch between named prompt/behavior configurations
(e.g. "concise mode," "brainstorm mode") without editing
`mana-avatar.json` or env vars directly.

## Why

Inspired by odysseus's Presets. Mana currently has one persona baked into
the system prompt, tunable only through direct config/env edits.

## Proposed Scope

- A small presets store (name + system-prompt-style instructions +
  relevant tuning knobs) separate from the full persona/avatar config.
- UI to create, select, and delete presets from the chat window.
- Selected preset's instructions get prepended/merged into the existing
  reply-building flow.

## Acceptance Criteria

- Users can create, rename, and delete presets from the UI.
- Selecting a preset visibly changes reply behavior without restarting
  Mana.
- No preset is required — default behavior is unchanged if none is
  selected.

## Status

Implemented.

- **Backend**: `node-bot/presets-store.js` is a single JSON-array file store
  (`{id, name, instructions, createdAt, updatedAt}`), matching the existing
  `presets are few and small` reasoning that ruled out per-item files.
  `node-bot/capabilities/presets-capability.js` exposes standard CRUD routes
  (`GET/POST /presets`, `PATCH/DELETE /presets/:id`), registered in
  `server.js` alongside the other capabilities and reported in `/health`.
- **Wiring**: `/reply` accepts an optional `presetId`; `buildAssistantReply`
  looks the preset up and appends its instructions after the mode's base
  system prompt (persona is not replaced, just extended).
- **Bug fix included**: while wiring this up, found that
  `runLocalAssistantReply` never forwarded the computed system prompt to the
  local model call, so mode personas (and now presets) had zero effect on
  local (non-remote) inference — the default path for virtually all users.
  Fixed and covered by a dedicated regression test.
- **UI (windows-launcher)**: a "Presets" panel in System status & tools
  (`index.html`, wired in `renderer.js`) with a select dropdown, New/Edit/
  Delete buttons, and an inline name+instructions editor. The selected
  preset persists across restarts via `localStorage` (same pattern as the
  selected model profile) and its id is sent as `presetId` on every normal
  chat `/reply` call. No pure logic was extracted into its own module (unlike
  compare-mode.js) — there wasn't anything here worth unit-testing beyond
  DOM wiring, which was instead verified live in a browser harness.
- **UI (desktop-client)**: a Presets panel behind the previously-inert
  "Settings" nav button (`index_fixed.html`, wired in `renderer.js`), same
  select/New/Edit/Delete/editor pattern as windows-launcher, persisted the
  same way via `localStorage`. desktop-client's primary interaction is voice
  (`POST /transcribe`, not `/reply`), so `/transcribe` now also accepts and
  forwards `presetId` to `buildAssistantReply` (`node-bot/server-routes.js`),
  covered by dedicated tests mirroring the existing `/reply` presetId tests.
  Compare mode there still deliberately omits `presetId`, matching
  windows-launcher's Compare mode.
- **Theme (desktop-client)**: restyled `desktop-client/renderer/style.css`
  from its original hardcoded light theme to the same Violet dark-purple
  token system windows-launcher's theme picker (issue #45) already uses
  (`--bg`, `--panel`, `--panel-2`, `--border`, `--text`, `--muted`,
  `--accent`, `--user-bubble`, `--mana-bubble`), including recoloring the
  avatar-stage and input-bar gradients so they read correctly on a dark
  background. No theme *picker* was added to desktop-client (not requested
  here) — just the Violet palette as its new default/only look.
- **Verified**: full node-bot test suite (backend CRUD, validation,
  persistence, and both the `/reply` and `/transcribe` system-prompt
  regression tests) and the windows-launcher suite both pass. Both the
  windows-launcher and desktop-client Presets panels were exercised live in
  separate browser harnesses (create, edit, delete, reload-persistence, and
  confirming `presetId` reaches the backend and is omitted when no preset is
  selected); the desktop-client Violet theme was verified via computed
  styles matching the expected token values.
