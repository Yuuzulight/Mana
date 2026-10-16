# browser-automation

Navigate/click/type/read a live page -- for driving a specific site
interaction (a form-gated result, paging through results, a site the user
already has a session for), not general search-and-extract (that's
`web-access.js`'s job and stays untouched). Disabled by default (Settings
> Plugins).

## Browser: Arcana

Arcana is the managed browser. Install the pinned CLI and checksum-verified
Obscura engine once from the repository root (Windows x64, .NET 10 SDK):

```powershell
./tools/install-arcana.ps1
```

The installer publishes into `node-bot/runtime/arcana`, which the plugin
finds automatically. `MANA_ARCANA_EXECUTABLE_PATH` can select another built
Arcana CLI (`Arcana.Cli.dll` or its apphost). The old
`MANA_BROWSER_EXECUTABLE_PATH` and `MANA_BROWSER_HEADLESS` settings no longer
select or launch Edge/Chrome. If Arcana is absent or cannot handle a site,
Mana reports the failure. The existing explicit "Open in my browser" action
uses Windows' registered default handler (Opera GX when that is your default).
It does not start a second managed browser.

M2 operational evidence is written as JSONL to `m2-events.jsonl` in the Arcana
profile (or `MANA_ARCANA_OBSERVABILITY_FILE`). `tools/m2-fallback-report.ps1`
summarizes the last seven days, separating explicit user takeovers from Arcana
startup failures.

Playwright connects to a fresh authenticated loopback CDP endpoint from
Arcana's ready file. The engine has one worker and at most 16 connections.
Local/LAN navigation is blocked unless `MANA_ARCANA_ALLOW_PRIVATE_NETWORK=1`
is explicitly configured. Personal Chrome connections through the separate
extension remain an explicit, separately approved mode.

## One light session and cookie persistence

Arcana starts lazily on the first browser call. The native launcher's preview,
Take over, and Done keep the same context and page. Mouse, keyboard, and
scrolling use a short-lived manual-control token; Done revokes queued input
before the agent resumes. Images and fonts are permitted during manual control.
No external takeover window is launched; older clients requesting one receive
a message directing them to the Browser panel.

- Mana owns `node-bot/data/arcana-profile`, separate from the old Chromium profile.
  `MANA_ARCANA_PROFILE_DIR` explicitly selects another absolute directory.
- An exclusive profile lease prevents concurrent sessions from overwriting it.
- Cookies are saved atomically in `credentials.json` on normal close and
  restored on the next launch. This file contains authentication data and is
  kept within the profile, outside Git. An abruptly terminated host can lose
  changes made since the last normal close.
- **Engine behavior:** Arcana's pinned Obscura revision keeps localStorage across
  same-origin navigation and persists it in the managed profile. sessionStorage
  remains scoped to the tab. Cookie and local-storage-based login persistence can
  survive a restart when the managed profile is reused.
- Playwright disconnect and process-tree cleanup are awaited before the profile
  lease is released. Engine logs are drained so a full pipe cannot stall it.

For selected personal Chrome tabs and existing logins, use the separate
[Mana Browser Connection](../browser-control-extension/README.md) extension.
Access is scoped to a confirmed chat session, optional exact-origin allowlist,
and explicit tab selection. Every personal-browser mutation needs fresh
approval; disconnect leaves the user's browser and tabs open.

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

## Test this site (#1161)

`test_site { urls, sizes? }` loads up to 5 pages at phone, tablet and
desktop size (images included) and checks each for console errors, failed
requests, layout that breaks out of the window, and basic accessibility
(missing alt text and labels, unnamed buttons and links, low contrast), with
a screenshot. Each page's links on the same site (up to 25) are checked
once. Every site in it needs her permission (#1154). She gets the counts;
the Browser panel's "Test report" opens the full report, with screenshots,
drawn by Folio. `GET /browser-automation/site-test` serves the latest one.

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

In the native launcher, **Take over** controls the existing page through
interactive frames inside Mana. No additional browser window opens. I do
the login, CAPTCHA or payment myself; manual input is not sent to the model.
**Done** revokes the manual token and resumes Mana with a fresh agent handle
at the page I finished on. While I have it, her browser calls wait.
Separate-window takeover is not supported by Arcana.

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
- `POST /browser/manual/start` -- `{ url? }`, returns a manual token.
- `GET /browser/manual/frame`, `POST /browser/manual/input`, and
  `POST /browser/manual/done` -- manual token in `X-Mana-Manual-Token`.
- `POST /browser/personal/start` -- `{ sessionId, origins? }`, returns a
  single-use extension connection code; `GET /browser/personal/status` reads status.

All local-only (same loopback check `/admin/restart` and the
brain-provider test route already use) -- this drives a real browser, so
it's exactly the kind of route that shouldn't be reachable from a
network-adjacent caller.

## Verification note

Deterministic tests cover page actions, authentication, approvals, ownership,
transport limits and cleanup. Two opt-in integrations also exercise a real
browser: set `MANA_BROWSER_TEST_EXECUTABLE` for the selected-page CDP relay,
and `MANA_EXTENSION_TEST_EXECUTABLE` for the actual unpacked extension.
Both verify that disconnect leaves the original user's browser usable.
The extension integration also checks screenshots and manual takeover/Done.
These integrations ran locally in isolated profiles; CI skips them unless
the executable paths are supplied. They never install in a personal profile.
