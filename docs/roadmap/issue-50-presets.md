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
