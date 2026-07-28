# context-push

Lets Mana reference the page or video you're currently looking at, fed by
the companion browser extension ([`plugins/context-push-extension`](../context-push-extension/)).
Disabled by default (Settings > Plugins) -- has no effect until you also
install the extension.

## Ephemeral, not memory

`POST /context/push` stores exactly one entry -- whatever was pushed most
recently -- capped in size and expiring after 2 minutes
(`CONTEXT_PUSH_TTL_MS` to override). It's in-memory only: never written to
disk, never fed into `acp-memory-store.js`'s retriever. This is live
browsing context, not a permanent record of pages visited.

## Loopback-only

Both `POST /context/push` and `GET /context/status` reject any request that
isn't from this PC (same `isLocalRestartRequest` guard `browser-automation`'s
routes use), regardless of Mana's other remote-exposure settings (issue
#14) -- arbitrary page text becoming part of Mana's reply context is a real
prompt-injection surface, so this route has no LAN-reachable path at all.

## "If asked", not every reply

`contributePromptContext` only contributes the pushed context when the
user's message actually looks like it's referencing the current page/video
(keyword-gated -- "page", "video", "watching", "this", etc.), the same
self-guarding pattern `ffxiv-market`/`stock-market` already use. It never
silently prepends "here's what you're looking at" to every single reply.

## Routes

- `POST /context/push` -- `{ url, title, text, videoSubtitle }`. Called by
  the browser extension's background script.
- `GET /context/status` -- whether there's a currently active (non-expired)
  entry.

## Setup

1. Enable this plugin in Settings > Plugins.
2. Install the browser extension -- see
   [`plugins/context-push-extension/README.md`](../context-push-extension/README.md).
