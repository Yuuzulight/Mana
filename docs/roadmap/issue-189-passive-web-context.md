# Issue 189: Passive "What Are You Looking At" Web Context

## Goal

Let Mana passively reference the page or video the user is currently
looking at (inspired by moeru-ai/airi's web extension), without becoming a
silent surveillance feature -- an always-on capture with a hard-to-miss
indicator and a one-click off switch, not a toggle-per-tab.

## Status: Implemented (`plugins/context-push`, `plugins/context-push-extension`, plugin(off) by default)

## Architecture

- **`plugins/context-push-extension/`** -- a Manifest V3 browser extension
  (Chrome/Edge). `content.js` reads `document.title`/`document.body.innerText`
  (capped at 4000 chars) plus, on YouTube, any currently-visible caption
  text (`.ytp-caption-segment` elements), and sends it to `background.js`
  every 20 seconds while a tab is open. `background.js` is the single
  source of truth for on/off state (`chrome.storage.local`, survives
  restarts) -- avoids every open tab's content script instance racing to
  read/interpret the same state independently. Only forwards to Mana's
  backend (`POST /context/push`) when capture is actually enabled.
- **`plugins/context-push/`** -- a new node-bot plugin. `context-push-store.js`
  holds exactly one ephemeral entry (whatever was pushed most recently),
  capped in size, expiring after 2 minutes (`CONTEXT_PUSH_TTL_MS`) --
  in-memory only, never written to disk or fed into `acp-memory-store.js`'s
  retriever. `contributePromptContext` only contributes it when the user's
  message actually looks like it's referencing the current page/video
  (keyword-gated), the same self-guarding pattern `ffxiv-market`/
  `stock-market` already use for their own `contributePromptContext`.
- **Loopback-only routes.** Both `POST /context/push` and
  `GET /context/status` reject anything that isn't from this PC (the same
  `isLocalRestartRequest` guard `browser-automation`'s routes already use,
  reused via `capabilityContext`) -- no exceptions, regardless of Mana's
  other remote-exposure settings (issue #14). Arbitrary page text becoming
  part of Mana's reply context is a real prompt-injection surface if it
  were ever LAN-reachable.

## The indicator and off switch, concretely

Per the issue's own explicit requirement (not optional caution):

- **Toolbar icon state.** A full color swap (green = actively reading,
  grey = off) via `chrome.action.setIcon`, plus an accessible tooltip via
  `chrome.action.setTitle` -- not a subtle badge dot that risks banner
  blindness.
- **One-click off.** `chrome.action.onClicked` toggles capture directly (no
  popup menu to dig through), persisted via `chrome.storage.local` so it
  stays off across browser restarts until re-enabled.
- **First-install onboarding.** On `chrome.runtime.onInstalled` with
  `reason === "install"`, capture starts **off** and a new tab opens
  (`onboarding.html`) explaining what the extension does before capture
  ever begins -- the user clicks "Got it, start reading pages" to actually
  turn it on. "Always-on by default" describes not needing a per-tab
  toggle afterward, not skipping informed consent on first install.

## Icons

Generated as minimal solid-color PNGs (green/grey, 16/48/128px) via a
small hand-rolled PNG encoder using Node's built-in `zlib.deflateSync` +
CRC32 -- no image-editing tool or new dependency needed for a plain
solid-color square icon, and the encoding was verified by re-inflating the
IDAT chunk and confirming the decoded pixel matches the intended color.

## Deliberate simplifications

- **`POST /context/push`, not a WebSocket server.** The issue offered
  either; a plain REST push route matches Mana's existing pull-based HTTP
  architecture (`web-access.js`, etc.) and needs no new server
  infrastructure, unlike a genuinely new WebSocket server.
- **Single current entry, not a history.** Matches the "what are you
  currently looking at" framing (singular, present) -- a new push simply
  replaces the previous one.
- **No per-site disabling.** The issue explicitly calls this a nice-to-have
  for v1, not required; a single global on/off switch is the real
  requirement.
- **No extension-side automated test harness.** No existing precedent in
  this repo for automated browser-extension testing (the other
  differently-shaped plugin, `obsidian-plugin`, is build-verified, not
  runtime-tested, either) -- covered instead by `node --check` syntax
  validation, JSON schema validation of `manifest.json`, and full unit
  coverage of the actual security/logic-bearing backend code (loopback
  guard, TTL expiry, size clamping, relevance gating).

## Out of scope (per the issue)

- Bilibili support.
- Actual audio/video capture or decoding beyond visible caption text.

## Verified

- `plugins/context-push/test/context-push-store.test.js` (8 tests): push
  requires a url, overwrite-not-accumulate, field clamping (title/text/url),
  TTL expiry clears state, `clear()`.
- `plugins/context-push/test/context-push.test.js` (7 tests): keyword-based
  relevance gating (both directions), empty-context handling, context
  formatting including video captions.
- `plugins/context-push/test/context-push-capability.test.js` (7 tests):
  loopback rejection on both routes, successful push + status round-trip,
  missing-url 400, plugin metadata (off by default), health reporting.
- `node-bot/test/health-components.test.js`: updated component-key
  snapshot for `contextPush`.
- Full `node-bot` suite (one process per file): no regressions.
- `manifest.json` validated as well-formed JSON; `background.js`/
  `content.js`/`onboarding.js` syntax-checked via `node --check`; icon PNGs
  verified by re-decoding and confirming pixel color.
