# Issue 190: Centralize the Hardcoded `localhost:5005` Backend URL

## Goal

First concrete step toward the always-on Mana server plan (repurposing a
GPU into a dedicated box running `node-bot`, with `windows-launcher`'s
Electron client pointing at it remotely). Confirmed via grep before
starting: `http://localhost:5005` was hardcoded in 32 places across 4
files (`main.js`, `renderer/renderer.js`, `renderer/session-sidebar.js`,
`renderer/sidebar-nav.js`), none of it configurable.

## Status: Implemented

- **`windows-launcher/backend-config.js`** (new, pure logic, no `electron`
  dependency -- same pure-logic-vs-orchestration split this codebase
  already uses for `artifact-detector.js`/`live2d-logic.js`):
  `assertValidBackendBaseUrl` (http/https-only, matching
  `model-management.js`'s existing user-configured-endpoint validation),
  `isLoopbackHostname`, and `createBackendConfigStore({configPath})` --
  `getBackendBaseUrl()`/`setBackendBaseUrl()`/`isBackendUrlLoopback()`
  backed by a JSON file (tmp-then-rename, same idiom `telegram-bridge.js`
  already uses), with an injectable `configPath` so tests never touch a
  real `userData` directory.
- **`main.js`**: wires that store to `app.getPath("userData")/mana-config.json`,
  exposes it over three `ipcMain` handlers (`get-backend-url` async,
  `get-backend-url-sync` for the renderer's one-time startup read,
  `set-backend-url` to persist a new value), and its own
  `BACKEND_URL`/`IDLE_REPORT_URL` constants became `getHealthUrl()`/
  `getIdleReportUrl()` functions of the configured value.
- **`startWindowsServices()`** now checks `isBackendUrlLoopback()` first --
  if the configured backend is remote, it does not also spawn a redundant
  local `node-bot` child process.
- **`renderer/backend-config.js`** (new, loaded first via `index.html`,
  before `renderer.js`/`session-sidebar.js`/`sidebar-nav.js`): reads the
  configured URL once, synchronously, via `ipcRenderer.sendSync("get-backend-url-sync")`
  into a module-level `BACKEND_BASE_URL`, plus `setBackendBaseUrl(url)`
  which persists via `ipcRenderer.invoke("set-backend-url", ...)`. Every
  one of the 32 hardcoded literals in the three renderer files was
  replaced with a reference to `BACKEND_BASE_URL` (mechanical
  regex-driven rewrite, then hand-verified: `node --check` on all three
  files plus a live CDP-driven smoke test of the actual fetch call sites).
- **Settings > Connection panel** (`index.html`): a text input pre-filled
  with the current value + a Save button, wired in `sidebar-nav.js`.

## Deliberate simplifications

- **Takes effect on next launch, not live.** `BACKEND_BASE_URL` is read
  once at renderer startup; Settings' Save button persists immediately
  but the running renderer keeps using its already-loaded value until
  restart. Threading a live-reload signal through 30+ call sites for a
  setting that changes rarely (a connection address) isn't worth the
  complexity -- this matches how changing a server address normally
  works elsewhere.
- **No reachability check in the Settings UI itself.** Save just
  persists the value; the existing Doctor panel and startup health check
  already surface whether the configured backend is actually reachable.

## Out of scope

- Actually running `node-bot` on a second machine, or any auth/security
  hardening beyond what issue #14 already added -- this issue is only
  the client-side plumbing to make the backend address configurable.

## Verified

- `windows-launcher/test/backend-config.test.js` (7 tests, new): URL
  validation (http/https accepted, everything else rejected), loopback-
  hostname detection, default-when-no-config-file, persist-then-read-back,
  trailing-slash stripping, invalid-URL rejection leaving the previous
  value in place, and a second store instance backed by the same
  `configPath` seeing what the first one persisted.
- Full existing `windows-launcher` suite (91 tests across 11 files, one
  file at a time): no regressions.
- Manual: launched the real Electron app (`electron .`), drove the real
  Settings > Connection panel via a raw CDP call -- confirmed
  `BACKEND_BASE_URL` was populated correctly at startup, the input was
  pre-filled with it, clicking the real Save button with a new URL
  persisted it (round-tripped back through the real `get-backend-url` IPC
  handler afterward, reading the real file on disk, not just the in-memory
  value), and the button showed "Saved -- restart to apply". Reset the
  test machine's config back to the default afterward so the next real
  launch isn't pointed at a fake IP.
