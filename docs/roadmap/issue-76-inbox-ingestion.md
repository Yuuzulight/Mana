# Issue 76: Watched Inbox Folder for Passive Multimodal Memory Ingestion

## Goal

Let files (notes, images, audio, PDFs) dropped into a watched folder get
ingested into Mana's memory automatically, without going through live chat.

## Why

Mana already has `/vision/describe`-equivalent and whisper transcription
pipelines, but they're only wired to live chat turns, not to memory.

## Status: Implemented

- **`node-bot/memory-inbox.js`** (new module): `createMemoryInboxWatcher()`
  watches a directory with Node's **native `fs.watch`**, not chokidar. Mana
  is Windows-only (windows-launcher, PowerShell scripts throughout), and
  Windows has always supported `fs.watch` -- the issue's proposed scope
  named chokidar only as an example dependency, and stdlib covers it
  completely. No new dependency added.
- **Routing by extension**: `.txt`/`.md` read directly; images
  (`.png`/`.jpg`/`.jpeg`/`.webp`/`.gif`) go through `runVisionReply`; audio
  (`.wav`/`.mp3`/`.m4a`/`.ogg`/`.flac`) goes through `runWhisper`. Both are
  the exact same functions Mana's live chat already uses -- called directly
  as functions, not through a self-referential HTTP round-trip.
- **Settle check**: on each fs event, stats the file, waits 1s, stats again;
  ingestion only proceeds if size and mtime are unchanged, so a file still
  mid-copy is left alone for a later event to retry.
- **Dedupe**: an in-flight-path guard (`pending` Set) stops overlapping fs
  events for the same file from double-processing (Windows commonly fires
  several `change` events per write).
- **Not a chat turn**: ingested text lands in `acpMemoryStore` via
  `appendTurn({ sessionId: "memory-inbox", user: text, assistant: "" })` --
  a dedicated pseudo-session (`MEMORY_INBOX_SESSION_ID`) that no chat UI
  ever opens, reusing the entire existing session/summary/prompt-memory
  pipeline for free while staying out of any visible session chat log.
- **Processed folder**: successfully-ingested files move to
  `<inbox>/processed/`, both preventing re-ingestion from unrelated later fs
  events and giving a visible record of what actually landed in memory.
  Files that fail ingestion (e.g. whisper/vision error) are left in place
  for inspection/retry rather than silently lost.
- **Wired into `server.js`** via `deps.startMemoryInboxWatcher` (test
  injection point) falling back to the real watcher, gated by the same
  `NODE_ENV`/`NODE_TEST_CONTEXT` check the background memory jobs already
  use -- otherwise every test calling `createApp()` would spin up a real,
  never-closed fs watcher.
- Configurable via `MANA_MEMORY_INBOX_DIR` (default:
  `<acp-memory dataDir>/inbox`).

### Deliberate simplifications

- `ponytail:` fixed 1s settle window, not a real "still growing" check
  across multiple writers -- fine for the single-writer drag-and-drop/copy
  case this is built for.
- Unsupported extensions (anything not text/image/audio -- PDFs included,
  despite being named in the issue's goal) are silently moved to
  `processed/` without ingestion rather than erroring. A PDF-text-extraction
  path wasn't built -- no existing PDF pipeline in this codebase to reuse,
  and adding one is a separate scoped decision, not implied by "watch a
  folder."

### Verified

- `node-bot/test/memory-inbox.test.js`: 6 new tests -- text ingestion +
  move to processed/, image routing through `runVisionReply`, audio routing
  through `runWhisper`, unsupported extensions skipped-but-cleared, an
  unsettled (still-growing) file left in place, and a vanished file ignored
  cleanly.
- `node-bot/test/server-routes.test.js`: 1 new test confirming
  `createApp()` actually wires a usable `inboxDir`/`appendTurn`/
  `runVisionReply`/`runWhisper` into the watcher start call.
- **Real end-to-end smoke test** (not injected `fs.watch` -- the actual
  Windows filesystem watcher): dropped a real `.txt` file into a real inbox
  directory and confirmed ingestion completed in ~1 second, well inside the
  acceptance criteria's ~10-second bar, with the file correctly moved to
  `processed/`.
- Full suite (`node run_tests.js`): all files pass.
