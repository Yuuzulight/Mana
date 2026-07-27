# Issue 153: Session Trajectory Export (ShareGPT JSONL)

## Goal

Pull a session's full message history out of Mana in a standard, portable
format for the user's own analysis or future fine-tuning.

## Tool calls weren't actually stored anywhere to preserve

Auditing before building: `acp-memory-store.js`'s stored turns were
`{at, user, assistant}` only. Tool-calling's reply path (issue #51,
opt-in, `MANA_TOOL_CALLING_ENABLED`) computes a `toolCalls` array per
reply, but it was only ever logged to console
(`Mana tool-calling: name(ok/error), ...`) -- never persisted. The issue's
acceptance criterion ("tool calls within the session are preserved in the
export, not dropped") couldn't be honestly satisfied without first fixing
that gap. Confirmed with the user before building: added a small,
low-risk capture rather than threading `toolCalls` through
`replyMaybeWithBestOfN`'s and the verify/retry loop's return values (both
currently just `string`, and touching either risks the wider reply
pipeline) -- a closure-scoped `let lastToolCalls` in the same function
that already defines `replyMaybeWithTools`, set right where the console
log already happens, read right where the existing `appendTurn` call
already sits. No other reply path (OpenAI proxy, vision) has tool calls to
begin with, so neither of those call sites needed to change.

## Status: Implemented (`node-bot/session-export.js` + a new `GET /sessions/:id/export` route + a windows-launcher sidebar action, core, always on)

- **`acp-memory-store.js`**: `appendTurn` now accepts an optional
  `toolCalls` array and stores it on the turn (`{name, ok, args, result}`
  each) -- omitted entirely when absent or empty, so every turn that never
  had tool calls keeps its existing `{at, user, assistant}` shape exactly.
- **`server.js`**: `replyMaybeWithTools`'s tool-calling path now also sets
  `lastToolCalls`, and the one `appendTurn` call downstream of it passes
  `toolCalls: lastToolCalls` through.
- **`session-export.js`**: `toShareGPTConversation(session)` builds
  `{id, conversations}` -- `human`/`gpt` for user/assistant turns,
  `function_call`/`observation` for each tool call (matching how
  fine-tuning tools like axolotl already extend the ShareGPT format for
  tool use), skipping an `observation` entry when a call has no result
  rather than emitting an empty one. `exportSessionAsShareGPTJSONL(session)`
  serializes that as one newline-terminated JSON line -- a single session
  is a single conversation, so "JSONL" here means exactly one line, still
  valid JSONL and consistent with a future batch-export-across-sessions
  extension (explicitly out of scope per the issue).
- **`GET /sessions/:id/export`** (`sessions-capability.js`): returns the
  JSONL text with `Content-Type: application/x-ndjson` and a
  `Content-Disposition: attachment` filename, 404 for an unknown session.
- **windows-launcher UI**: the session sidebar's existing right-click
  context menu (Rename/Open memory/Delete) gets a new "Export (ShareGPT
  JSONL)" entry. `session-sidebar.js`'s `exportSession(sessionId)` fetches
  the JSONL text and hands it to a new `ipcMain.handle("save-export-file")`
  in `main.js`, which opens a native save dialog and writes the file --
  local file output only, no upload/sync anywhere, matching the issue's
  scope. Scoped to windows-launcher per the issue text (desktop-client's
  session list wasn't mentioned and wasn't touched).

## Deliberate simplifications

- **Per-session export only.** Batch export of every session at once is
  explicitly out of scope per the issue.
- **No training/fine-tuning pipeline.** Export format only, per the
  issue's own "out of scope" section.
- **`toolCalls` capture only covers the local tool-calling path.** The
  OpenAI-proxy and vision reply paths have no tool calls to preserve in
  the first place, so nothing changed there.

## Verified

- `node-bot/test/acp-memory-store.test.js` (24 tests, 2 new): `toolCalls`
  persisted when provided, omitted entirely (not stored as `undefined` or
  an empty array) when absent or empty.
- `node-bot/test/session-export.test.js` (7 tests): plain turns, tool
  calls preserved as function_call/observation pairs, non-string results
  JSON-stringified, a resultless tool call skipping its observation entry,
  multi-turn ordering, exactly-one-line JSONL output, and an empty session.
- `node-bot/test/sessions-capability.test.js` (7 tests, 1 new): the export
  route's content-type/content-disposition headers, JSONL body shape, and
  404 for an unknown session.
- `node-bot/test/server-routes.test.js`: full regression pass after the
  `lastToolCalls` capture change.
- **Manual verification (2026-07-28): real Electron instance, no bugs
  found.** Launched the actual `windows-launcher` app (`electron .`),
  which spawned its own real `node-bot` backend as a child process exactly
  as production does. Drove the real renderer's `exportSession()` for a
  real 15-turn session (`60972697-...`) via a raw CDP call into the
  running "Mana" window -- same function the context-menu's "Export"
  button calls, exercising the real `fetch` to the real
  `GET /sessions/:id/export` route and the real
  `ipcRenderer.invoke("save-export-file")` call into `main.js`. The real
  native Windows save dialog appeared and the user manually clicked Save
  on it (the one piece that can't be scripted -- a genuine native OS
  modal). Result: a real `.jsonl` file written to disk containing 30
  conversation entries (15 human + 15 gpt, correctly alternating,
  matching the session's 15 real turns exactly), all non-empty strings.
  No bugs found.
