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
  renderer. When ads were blocked and the page looks broken (next to
  nothing to read or use, or an action or page load timing out; script
  errors alone don't count, #1179), her result and
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

## Developer tools (#1161)

`devtools { do }` on the current page, on any site she's allowed to act on
(#1154 -- no separate mode or allow-list):

- `console`: the page's console messages and uncaught errors, errors first.
- `network`: failed requests (errors, HTTP 4xx/5xx) and the slowest ones,
  with timings. Requests we block ourselves (ads, media) aren't listed.
- `run_js { code }`: one JavaScript expression, its value back as JSON
  (capped at 2000 characters). It asks for the site on its own
  (`browser-js:<host>`: once, session, always, deny, never); allowing a
  site for clicks doesn't allow scripts. Never on password or payment pages.
- `viewport { size: phone | tablet | desktop }` and
  `color_scheme { scheme: light | dark }`.
- `look { question }`: a screenshot her vision model describes. Off while
  gaming, never on password or payment pages.

Each tab keeps its last 100 console messages and requests, cleared when it
loads a new page. Everything the page says comes back inside the untrusted
frame.

## Look and click (#1157)

`look_and_click { description }` is the last resort for pages with no
useful accessibility info (canvas apps, unlabeled custom UIs). It only
runs when `find` sees nothing matching; then her own vision model gets a
screenshot and answers with x,y, and she clicks there. Off while a game
runs, asks for the site like a click, refused on password/payment pages.
Images on the page only show while the Browser panel is on screen (#1137),
so an image-only icon is easier to spot with the panel open.

## Uploads and downloads (#1158)

- `upload { ref, file }` fills a file input, or answers the file chooser a
  button opens, only with a file I pointed her to in the last 30 minutes:
  its full path in my own chat message, or one I picked with the Browser
  panel's "Give her a file". Never keys or secrets (`.env`, `id_rsa`...),
  never one she chooses herself. It asks for the site like a click.
- A download waits in `node-bot/data/browser-downloads-pending` for my OK
  in Approvals, every time (never "always"). Approved, it goes into one
  folder (`MANA_BROWSER_DOWNLOAD_DIR`, default `Downloads\Mana`), never
  overwriting, marked as from the internet (Zone.Identifier), and the chat
  says where it is. She never opens it. Unapproved ones are swept after a day.

## Tabs (#1159)

`tab { do: "open", url }`, `{ do: "switch", number }`, `{ do: "close", number }`:
up to 3 tabs (`MANA_BROWSER_MAX_TABS`, 1 to 5) for comparing pages. With
more than one open, every answer lists them (title and URL). A new tab
isn't opened while RAM is above 85%, and when her reply ends only the tab
she's on stays open (popups a site opened go too).

## Batches (#1160)

`batch { steps }` runs up to five steps (any action but `hand_over`, each
with its own arguments) in one call. Each step goes through the same site
check and activity feed as when called alone. The first step that fails
or needs my OK ends the batch, and she gets a fresh look at the page.

## Finding an element by description (#1156)

`find { description }` ("the Sign in button", "the search box") looks at the
whole page (not just the 150 elements a snapshot shows) and returns up to
five best matches with their refs, ranked by the words of each element's
name, a whole-phrase match, and the kind of element the description names.
It only reads, so it never asks.

## Hover, keys and drag (#1155)

`hover` (menus that open on hover), `press` (Enter, Escape, Tab, arrows,
Home/End, PageUp/PageDown, Backspace, Delete, Space, letters, with Shift, or
Ctrl+A/Z/Y/B/I/U -- never Alt, Meta, F-keys, tab/window shortcuts, or copy,
cut and paste, which reach my clipboard) and `drag` (one ref onto another).
Press and drag ask for the site like a click; hover doesn't.

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
