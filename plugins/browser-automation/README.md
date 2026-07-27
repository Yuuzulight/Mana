# browser-automation

Navigate/click/type/read a live page -- for driving a specific site
interaction (a form-gated result, paging through results, a site the user
already has a session for), not general search-and-extract (that's
`web-access.js`'s job and stays untouched). Disabled by default (Settings
> Plugins).

## Browser: Edge by default, override with an env var

Windows ships Edge (Chromium-based) on every install, so this plugin
launches it by default instead of asking anyone to separately install a
browser. Set `MANA_BROWSER_EXECUTABLE_PATH` to point at Chrome, or a
`playwright install chromium`-downloaded browser, instead.
`MANA_BROWSER_HEADLESS=0` shows the window instead of running headless.

## Ref-based interaction, not coordinates

`POST /browser/navigate` and every action route return a `snapshot`:
`{url, title, text, interactiveElements}`. `text` is a plain, token-
efficient extraction (`document.body.innerText`, capped), not a
screenshot or raw HTML dump. Each entry in `interactiveElements` has a
stable `ref` (assigned via a `data-mana-ref` attribute the first time an
element is seen, kept afterward) -- `POST /browser/click` and
`POST /browser/type` take that `ref`, not coordinates.

## Routes

- `POST /browser/navigate` -- `{ url }` (http/https only).
- `POST /browser/snapshot` -- re-reads the current page's state.
- `POST /browser/click` -- `{ ref }`.
- `POST /browser/type` -- `{ ref, text }`.
- `POST /browser/close` -- ends the session.

All local-only (same loopback check `/admin/restart` and the
brain-provider test route already use) -- this drives a real browser, so
it's exactly the kind of route that shouldn't be reachable from a
network-adjacent caller.

## Verification note

No real browser was launched in the environment that built this (CI
runners have no Windows/Edge install, and this session's own Browser pane
was unresponsive throughout). `browser-automation.js`'s actual logic
(navigation validation, ref assignment, snapshot shape) is verified
against a fake "page-like" object
(`{goto, evaluate, click, type, title, url}`) in tests -- production code
passes it a real Playwright `Page`, whose method names and signatures
already match that shape, so no adapter layer was needed. The
route-level wiring (executable-path resolution, loopback gating) is
tested directly; the actual browser launch itself is not.
