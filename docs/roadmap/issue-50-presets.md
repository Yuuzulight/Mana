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
- **desktop-client**: not ported. Not requested for this issue and, unlike
  Compare mode, there's been no follow-up ask to add it there.
- **Verified**: full node-bot test suite (backend CRUD, validation,
  persistence, and the system-prompt regression tests) and the
  windows-launcher suite both pass. The Presets panel was exercised live in
  a browser harness (create, edit, delete, reload-persistence, and
  confirming `presetId` reaches `/reply` and is omitted when no preset is
  selected).
