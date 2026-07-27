# Issue 150: Interactive Browser Automation

## Goal

Navigate/click/type/read a live page -- for a specific site interaction
`web-access.js`'s search-and-extract can't do -- with token-efficient
text-mode reads and stable ref-based element addressing rather than
coordinates.

## Browser choice: Edge by default, not a new download

Neither Playwright nor Puppeteer was already a dependency. Installed
`playwright-core` (the browser-binary-free variant -- no Chromium download,
~1 package) rather than full `playwright`, and default the launch target
to Edge's standard Windows install path
(`...\Microsoft\Edge\Application\msedge.exe`) instead of asking anyone to
separately install a browser -- Windows ships Edge (Chromium-based) by
default, and Mana already only targets Windows.
`MANA_BROWSER_EXECUTABLE_PATH` overrides this for Chrome or a
`playwright install chromium`-downloaded browser instead.

## Status: Implemented (`plugins/browser-automation/`, toggleable, off by default)

- **`browser-automation.js`**: `createBrowserSession({page})` where `page`
  is a narrow "page-like" interface (`goto`/`evaluate`/`click`/`type`/
  `title`/`url`) rather than Playwright's full API surface -- this is what
  makes the module testable without a real browser: a real Playwright
  `Page`'s methods already match this exact shape (same names, same
  signatures), so production passes it through with zero adapter code,
  and tests inject a plain fake object instead.
- **Ref-based interaction**: `snapshot()` runs a page-context function
  (`snapshotInPage`) that queries visible interactive elements
  (links/buttons/inputs/textareas/selects/ARIA roles), assigns each a
  stable `data-mana-ref` attribute the first time it's seen (kept on
  subsequent snapshots of the same page), and returns
  `{ref, tag, role, label}` for each. `click(ref)`/`type(ref, text)` act
  on `[data-mana-ref="<ref>"]`, never coordinates.
- **Text-mode reads by default**: `extractTextInPage` returns a capped
  `document.body.innerText` (`MAX_PAGE_TEXT_CHARS`, 6000 -- matching
  `web-access.js`'s own existing page-text budget for consistency), not a
  screenshot or raw HTML dump.
- **Routes**: `POST /browser/navigate|snapshot|click|type|close`, all
  gated by the same loopback-only check `/admin/restart` and the
  brain-provider test route already use (`isLocalRestartRequest`, now
  added to the shared capability context) -- driving a real browser is
  exactly the kind of capability that shouldn't be reachable from a
  network-adjacent caller.

## Deliberate simplifications

- **`web-access.js` untouched.** This is for driving a specific page
  interaction; the existing search+extract path stays the default route
  for "just get information from the web."
- **No anti-fingerprinting/bot-detection evasion.** Explicitly out of
  scope per the issue.
- **No session recording/video capture.** Explicitly out of scope per the
  issue.
- **Single persistent session, not a pool.** Matches the issue's "drive a
  specific interaction" framing (a sequence of steps on one page), not
  concurrent multi-page automation -- a second session would be a
  `Map`-keyed extension of the same module-level-singleton pattern
  `cron-scheduler`/`image-generation` already use, if ever needed.

## Manual verification (2026-07-28): real browsers, no bugs found

Ran the actual routes (not the fake-page unit tests) against two real,
locally-installed Chromium-family browsers via a real `playwright-core`
launch, driving a full navigate -> snapshot -> type -> type -> click ->
snapshot -> close flow against a live public login page
(`https://the-internet.herokuapp.com/login`, using its own published demo
credentials):

- **Edge**, auto-detected via `resolveExecutablePath`'s default path
  (`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`, no env
  override) -- typed into both real `<input>` refs, clicked the real
  "Login" button ref, and the resulting snapshot showed the real
  post-login page (`/secure`, "You logged into a secure area!").
- **Opera GX**, via `MANA_BROWSER_EXECUTABLE_PATH` pointed at
  `C:\Apps\Opera Gx\opera.exe` -- identical flow, identical result,
  confirming the override path works against a real non-Edge Chromium
  browser (not just Edge's own hardcoded default).

Both runs: ref-based `click`/`type` worked against real DOM elements
(refs assigned by the real `snapshotInPage` `data-mana-ref` logic, not a
fake), `snapshot()`'s parallel `evaluate`/`title`/`url` calls resolved
correctly against the real page, and `close` tore down the real browser
handle cleanly. No bugs found -- the fake-page unit tests' shape matched
the real Playwright `Page` API exactly, as the module's own design
intended.

Chrome itself isn't actually installed on this machine (no registry
`App Paths` entry, no Start Menu shortcut, no exe under either Program
Files or the per-user install location) so it wasn't separately tested,
but since the plugin treats every non-Edge browser identically through
the same `MANA_BROWSER_EXECUTABLE_PATH` + `playwright-core.chromium`
path, Opera GX passing is strong evidence Chrome would too.

## Verified

- `plugins/browser-automation/test/browser-automation.test.js` (10
  tests): missing-page-object rejection, non-http(s) URL rejection,
  navigate/click/type each returning a fresh snapshot, ref requirement
  enforcement, text coercion, the text-cap constant, and
  `snapshotInPage`/`extractTextInPage` exercised directly against fake
  DOM globals (ref stability across repeated snapshots, trim+truncate).
- `plugins/browser-automation/test/browser-automation-capability.test.js`
  (6 tests): executable-path resolution (env override, Edge-path
  detection, not-found case), every route rejecting a non-loopback
  request without touching the browser, a clear error when no executable
  is configured, and a full injected-fake-chromium navigate flow.
- `node-bot/test/health-components.test.js` (3 tests): updated snapshot
  for the new `browserAutomation` component key.
- `node-bot/test/server-routes.test.js` (62 tests): unaffected.
- Manual: real end-to-end run against real Edge and real Opera GX (see
  above) -- no bugs found.
