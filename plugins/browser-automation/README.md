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

## One light, persistent session (#1137)

- Mana's own profile in `node-bot/data/browser-profile`
  (`launchPersistentContext`), so a site I log in to stays logged in.
- Started on her first browser call; one context, one page.
- `--disable-gpu` (no VRAM) and `--renderer-process-limit=1`.
- Images, video and fonts are blocked (`page.route`) unless the rail's
  Browser panel is on screen, for its screenshot.
- Ad and tracker domains (`ad-hosts.js`, a short hand-kept list) are always
  blocked (#1168): under site isolation each cross-site ad iframe is its own
  renderer. When ads were blocked and the page looks broken (script errors,
  next to nothing to read or use, or an action timing out), her result and
  the Browser panel say the site may need them, with "Open in my browser".
  She doesn't retry without blocking.
- Closes after 5 idle minutes, and never starts (or closes at once) while
  a watched game runs or RAM is above 85% -- self-work's gates.

## Accessibility snapshots and refs (#1138)

What she reads is Playwright's AI accessibility snapshot
(`page.ariaSnapshot({ mode: "ai", depth: 40 })`, iframes included), cut
down to its interactive lines (`button "Go" [ref=e5]`, up to 150), plus
the first 1500 characters of the page's text. She acts by those refs
(`aria-ref=e5`): click, type (optionally pressing Enter), select, scroll,
back, and navigate. After an action on the same page she gets only the
elements that appeared or went; a new page (or one that mostly changed)
gets a fresh snapshot. Everything from the page reaches the model inside
one untrusted frame (`ai/untrusted-content.js`). Screenshots are only for
the Browser panel, taken while it's on screen; the model never sees one.

## Asking before acting on a new site (#1154)

The first time she clicks, types or selects on a site (host, `www.`
dropped), I'm asked in Settings > Approvals: Allow once (that one step),
Allow for session, Always allow, Deny, or Never. Reading, scrolling, going
back and opening pages never ask. Always and Never are remembered per site
(`browser-site:<host>`) and listed under "Remembered answers" with Forget.

## Take over and hand back (#1139)

Chromium can't turn a headless session visible, so **Take over** (the
Browser panel's button) closes hers and opens the same profile as a normal
Edge window at her page. I do the login, CAPTCHA or payment there myself;
nothing I type goes to the model. **Done** closes the window (so does
closing it myself) and she carries on headless, with my login kept, at the
page I finished on. While I have it, her browser calls wait.

She never types credentials or pays: on a page with a password, one-time
code or card field, a payment provider's iframe, or a checkout/payment/
billing URL, her click, type and select are refused, and the panel asks me
to take over. She can also ask herself (`browser_automation__hand_over`).

## Routes

- `POST /browser/navigate` -- `{ url }` (http/https only).
- `POST /browser/snapshot` -- re-reads the current page's state.
- `POST /browser/click` -- `{ ref }`.
- `POST /browser/type` -- `{ ref, text }`.

Each returns `{url, title, elements, text}`, or after an action on the
same page `{url, title, added, removed, text?}`.
- `POST /browser/close` -- ends the session.
- `POST /browser/take-over` -- `{ url? }`, and `POST /browser/hand-back` (admin key too).

All local-only (same loopback check `/admin/restart` and the
brain-provider test route already use) -- this drives a real browser, so
it's exactly the kind of route that shouldn't be reachable from a
network-adjacent caller.

## Verification note

No real browser was launched in the environment that built this (CI
runners have no Windows/Edge install, and this session's own Browser pane
was unresponsive throughout). `browser-automation.js`'s actual logic
(navigation validation, snapshot filtering, ref actions) is verified
against a fake "page-like" object
(`{goto, ariaSnapshot, locator, evaluate, title, url}`) in tests -- production code
passes it a real Playwright `Page`, whose method names and signatures
already match that shape, so no adapter layer was needed. The
route-level wiring (executable-path resolution, loopback gating) is
tested directly; the actual browser launch itself is not.
