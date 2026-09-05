# Issue 508: Evaluate Obscura As A Lighter Browser Engine

## Goal

Decide whether swapping the browser-automation plugin's engine from
Playwright+Chromium to Obscura is worth it, on measured resource savings
and correctness parity rather than the project's own claimed numbers.

## Why

`plugins/browser-automation/` (#150) drives a full headless Chromium
instance via Playwright today. h4ckf0r0day/obscura is a Rust-based
headless browser engine that's a drop-in replacement via the same CDP
protocol, claiming dramatically lower memory/binary size/startup time,
plus built-in anti-detection and native MCP support. Mana is a background
companion app designed to stay light (gaming-mode backoff, resource-
conscious throughout) -- a heavy Chromium footprint for occasional
automation tasks is exactly the kind of thing worth challenging if a
lighter engine does the same job through the same protocol.

## Proposed Scope

- Evaluation only, not a commitment to switch.
- Swap-test Obscura via its CDP server against Mana's existing
  `plugins/browser-automation/test/` suite for correctness parity.
- Measure real memory/startup/page-load numbers on Mana's own hardware,
  not the project's published benchmarks.
- Only proceed to an actual swap if correctness parity holds and the
  resource savings are real.

## Acceptance Criteria

- A documented comparison: correctness (existing test suite passes
  against Obscura), memory, startup time, page-load time, measured on
  Mana's own hardware.
- A clear build/don't-build recommendation.

## Method

`plugins/browser-automation/test/*.test.js` turned out not to exercise
this by itself -- it injects a fake page object (`browser-automation.js`'s
own file header says so: "No real browser was launched in the process
that built this"), so it passes identically regardless of engine and
can't show correctness parity on its own. Instead, `createBrowserSession()`
-- the real production wrapper, not a fake -- was driven against two real
browsers:

- Real headless Chromium, launched the same way `index.js` does
  (`playwright-core`'s `chromium.launch({ executablePath, headless: true })`).
- Real Obscura 0.2.1 (the `obscura-x86_64-linux` release binary), run as
  `obscura serve --port 9222 --allow-private-network` and attached via
  Playwright's `chromium.connectOverCDP()` -- the same call an actual
  `index.js` swap would use.

Both ran the identical sequence -- navigate, snapshot, click a button,
type into an input, screenshot -- against a small local test page (a
link, a button, an input, one inline `<script>`), served from
`127.0.0.1` so page-load timing wasn't confounded by network variance.
Memory was total RSS of the browser process and its children (a
single-process reading badly understates a real Chromium/Obscura
footprint, since both spawn helper processes even for one tab).

Caveat: this ran in a Linux cloud container, not Mana's actual Windows
hardware -- absolute numbers will differ there, though the relative gap
between the two engines should hold. A real-site navigation
(`https://example.com/`) was also attempted for a more realistic
page-load number, but the container's outbound proxy setup made
Chromium's direct connection unreliable (`net::ERR_CONNECTION_RESET`);
that number is an environment artifact, not a real product difference,
and isn't reported below.

## Findings

**Resource claims: real, and larger than advertised for Chromium's
side.**

| | Chromium | Obscura |
| --- | --- | --- |
| Startup to ready | ~190-240ms | ~20-35ms |
| Total RSS (browser + children, one tab) | ~725 MB | ~47 MB |

Roughly a 15x memory difference and 6-10x faster startup. Chromium's
real total-RSS number here is actually worse than the README's own
"200MB" claim (which likely counts a single process, not the full
tree); Obscura landed close to its own claimed ~30MB.

**Two correctness gaps, both in exactly what this plugin depends on:**

1. **Missed interactive elements.** On the test page (one link, one
   button, one input), Obscura's `interactiveElements` only reported 2
   of the 3 -- the plain `<a href="#">` link never appeared (Chromium
   found all 3). `click()`/`type()` work by ref from that list, so any
   automation flow needing to click a link would silently be unable to
   see it as clickable via Obscura.
2. **Text extraction leaks script source.** Obscura's `innerText`
   equivalent included the raw text of the page's `<script>` tag, as if
   it were visible content; Chromium correctly excludes non-rendered
   script text. `extractTextInPage()` is what feeds page content to the
   model, so this would put raw JavaScript into the model's context on
   any page with inline scripts.

Screenshot output also differed a lot in size for the same page (~29KB
vs. ~10KB JPEG) -- likely just an encoder/quality difference, not
flagged as a correctness issue.

## Recommendation

**Don't swap yet as-is.** The resource case is real and worth continuing
to track -- a 15x memory difference for a background companion app is
significant -- but both correctness gaps found sit directly in the two
functions `browser-automation.js` relies on most (element targeting,
text extraction), not in some edge case.

Building a custom lightweight engine instead of adopting Obscura isn't
worth considering here: a real HTML/CSS/JS engine (parsing, layout, JS
execution, networking) is one of the largest categories of software that
exists, and matching even Obscura's current ~90%-there state from
scratch would cost vastly more than the resource win is worth -- almost
certainly landing with more rough edges than these two known gaps, not
fewer.

The two gaps themselves are narrow and specific enough to patch at
Mana's own integration layer instead of waiting on either option above:

1. After reading Obscura's `interactiveElements`, also scan the page for
   plain `<a href>` tags and merge in any missing from that list.
2. Before feeding page text to the model, strip `<script>...</script>`
   blocks from Obscura's extracted text.

Both are small, targeted fixes in `browser-automation.js` (or a thin
Obscura-specific wrapper around it), not touching Obscura's engine
internals -- this gets the 15x memory / 6-10x startup win now, without
depending on Obscura's own release timeline. Filing both gaps upstream
with Obscura is still worth doing in parallel, so the patch can
eventually be dropped once fixed there.

## Related

#150
