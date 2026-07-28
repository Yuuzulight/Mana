# context-push-extension

A Manifest V3 browser extension (Chrome/Edge) that reads the current page's
text -- and, on YouTube, any visible caption text -- and pushes it to
Mana's `POST /context/push` route, so she can answer "what does this page
say" or "what am I watching" without you having to paste anything.

This is a companion to the [`context-push`](../context-push/) node-bot
plugin -- installing the extension alone does nothing until that plugin is
also enabled in Settings > Plugins.

## Install (unpacked, until this is published to a store)

1. Open `edge://extensions` (or `chrome://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder
   (`plugins/context-push-extension`).
4. A new tab opens explaining what the extension does -- read it, then
   click **Got it, start reading pages**. Capture starts only after this.

## Always-on, but never silent

Once started, the extension reads the current page continuously -- not
just when you ask Mana something. Two things make that acceptable instead
of invasive:

- **The toolbar icon is the indicator.** A solid color swap (green =
  reading, grey = off), not a subtle badge dot -- hover it for a tooltip
  confirming the current state.
- **A single click is the off switch.** Click the toolbar icon anytime to
  turn capture off; it stays off, even across browser restarts, until you
  click it again.

## What gets sent

Per page: the URL, page title, up to 4000 characters of visible page text,
and (YouTube only) any caption text currently on screen. Sent to
`http://127.0.0.1:5005/context/push` every 20 seconds while a tab is open
and capture is on -- nothing is sent while capture is off. Mana holds only
the single most recent page, for 2 minutes, then it's gone.

## Out of scope

- Bilibili (only YouTube's caption overlay is read).
- Actual audio/video capture or decoding -- only visible caption text, if
  the video has captions turned on.
- Per-site disabling (only a single global on/off switch in v1).

## Changing which backend it talks to

If Mana's backend isn't at the default `http://127.0.0.1:5005`, set
`backendUrl` in the extension's storage (`chrome://extensions` >
this extension > **service worker** console >
`chrome.storage.local.set({backendUrl: "http://127.0.0.1:5005"})`). No
settings UI for this yet -- most installs run Mana co-located on the same
PC as the browser, where the default already works.
