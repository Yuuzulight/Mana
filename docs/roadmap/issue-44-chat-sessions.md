# Issue 44: Add Named Chat Sessions With Rename, Delete, and Memory Management

## Status

Implemented. `node-bot/acp-memory-store.js` now tracks a `name` per session
(auto-generated from the first user message, renamable), plus
`listSessions`/`renameSession`/`deleteSession`. `capabilities/sessions-capability.js`
exposes this over HTTP (`GET /sessions`, `GET/PATCH/DELETE /sessions/:id`).
`windows-launcher/renderer/session-sidebar.js` adds the sidebar UI: a session
list with relative dates, a "New chat" button, and a right-click menu for
rename (inline edit), delete (with confirmation), and "open memory" (a modal
showing the session's stored summary and recent turns). The existing
single-session flow is unchanged for anyone who never opens the sidebar.

## Goal

Give Mana a real session list so conversations can be organized, revisited,
and independently managed, instead of one continuous chat.

## Why

Inspired by odysseus's session list (right-click rename/delete/memory
options). Mana's ACP memory store already persists conversation memory, but
there's no UI to see, name, or manage separate conversations.

## Proposed Scope

- Add a session list UI (sidebar) showing past conversations by name/date.
- Support right-click (or menu) actions: rename, delete, and "open memory"
  (jump to that session's stored ACP memory).
- New sessions get an auto-generated name (first message excerpt) with
  manual rename support.
- Session metadata (name, created/updated timestamps) persisted alongside
  existing ACP memory storage.

## Acceptance Criteria

- Users can see a list of past chat sessions.
- Users can rename and delete a session from the UI.
- Selecting "memory" for a session surfaces its stored ACP memory entries.
- Existing single-session behavior remains the default for users who don't
  create additional sessions.
