# Issue 148: Renderable Artifacts

## Goal

Render markdown/fenced code in the chat log instead of raw text, and let a
long or `html`-tagged block open in its own view instead of dominating a
chat bubble, in both `windows-launcher` and `desktop-client`.

## Scope check before building

The issue's framing suggested a wide problem ("63 call sites" of plain-text
insertion). Auditing found exactly one chokepoint per app --
`appendChatMessage()` in `windows-launcher`, `appendMessage()`/
`prependTurns()` in `desktop-client` -- everything else was unrelated UI
text (status labels, transcripts). Confirmed the smaller real scope with
the user before implementing rather than building for the wider premise.

## Status: Implemented

- **`marked` + `dompurify`** added to both apps (0 production-dependency
  vulnerabilities; verified via `npm audit --omit=dev`). No lighter
  alternative exists for correct, safe markdown -- hand-rolling either
  parsing or sanitization is exactly the kind of thing that quietly grows
  an XSS hole.
- **`artifact-detector.js`** (new, identical in both apps -- same
  independent-per-app-copy pattern as `live2d-logic.js`): pure, DOM-free
  `extractArtifact(text)` finds the first fenced block that's either
  tagged `html` (always artifact-worthy, meant to be viewed not read) or
  long enough (`ARTIFACT_MIN_CHARS`, 400) that inlining it would dominate
  the bubble.
- **`markdown-render.js`** (new, identical in both apps):
  `createMarkdownRenderer()` returns `renderMarkdownToSafeHtml(text)` --
  `marked.parse()` then `DOMPurify.sanitize()`. Needs a real DOM to
  construct DOMPurify; in `windows-launcher` (nodeIntegration on) that's
  just the ambient `window`, in `desktop-client` (contextIsolation on,
  issue #122) it's required from `preload.js`/the artifact window's own
  preload instead, with only the resulting string-in/string-out functions
  crossing the `contextBridge`.
- **Chat bubbles**: both apps' single insertion function now calls
  `extractArtifact` first, strips the matched block from what's shown
  inline, renders the remainder via `renderMarkdownToSafeHtml`, and (if a
  block was found) appends an "Open _language_ content in new window"
  button.
- **Standalone view**: a second `BrowserWindow` per app (`artifact/`),
  reused across multiple opens rather than spawned per-artifact.
  `windows-launcher`'s uses the same `nodeIntegration:true` shortcut its
  other secondary window (avatar) already uses; `desktop-client`'s is
  sandboxed with its own dedicated preload, matching how its main window
  was hardened in issue #122 -- deliberately *not* reusing the
  nodeIntegration shortcut just because it was simpler, since that would
  reintroduce exactly the risk profile that issue moved away from.
- **CSS fix caught in review**: `windows-launcher`'s `.chat-message` had
  `white-space: pre-wrap` (needed when content was plain text). Left in
  place, it would have doubled up spacing now that bubbles contain real
  HTML (paragraph/list tags already provide block spacing) -- removed, and
  first/last-child margins zeroed so a single paragraph doesn't add extra
  padding.

## Verification limitation (disclosed, not glossed over)

This session's Browser pane was unresponsive (repeated navigation
timeouts, failed tab creation) for the duration of this issue, so the
markdown-render + sanitization pipeline could not be visually confirmed in
a live browser, and the Electron apps themselves weren't launched end-to-
end (they depend on the full node-bot backend + audio stack). What *was*
verified:
- `marked.parse()`'s actual output directly in Node (headers/bold/lists/
  fenced code all produce correct HTML) -- confirmed working.
- `DOMPurify.sanitize()` itself was not exercised against a live script-
  injection attempt in this session. It's a widely-used, purpose-built
  sanitization library (not something hand-rolled here); the wiring
  (`purify.sanitize(marked.parse(text))`) is the library's own documented
  pattern. This is disclosed as a real gap, not claimed as verified --
  worth an actual click-through (type a message containing
  `<script>alert(1)</script>` or an `onerror` image tag, confirm nothing
  executes) before or shortly after this ships.

### Manual verification (2026-07-28): real Electron instance, no bugs found

Launched the real `windows-launcher` app (`electron .`, with its own real
`node-bot` backend spawned as normal) and called the real
`appendChatMessage("user", text)` -- the exact chokepoint this doc's audit
identified -- with three live payloads, then read back the actual bubble
`innerHTML` and listened for `Page.javascriptDialogOpening` CDP events
(which would fire if an `alert()` actually executed):

- `<script>window.__xss1 = true; alert(1)</script>` -> bubble ended up
  empty; the `<script>` tag was stripped entirely, `window.__xss1` stayed
  `false`, no dialog opened.
- `<img src="x" onerror="window.__xss2 = true">` -> rendered as
  `<img src="x">` -- the `onerror` attribute itself was stripped,
  `window.__xss2` stayed `false`.
- `<svg onload="window.__xss3 = true"><script>window.__xss3b = true</script></svg>`
  -> rendered as an empty `<svg></svg>` -- both the `onload` handler and
  the nested `<script>` were stripped, neither flag flipped.

No bugs found -- `purify.sanitize(marked.parse(text))` behaves exactly as
DOMPurify's own documentation promises against all three of the most
common injection shapes (script tag, event-handler attribute, nested
script inside a non-script element).

## Deliberate simplifications

- **No new node-bot routes or capability.** "Mana can produce content that
  opens in its own view" is satisfied by detecting artifact-worthy content
  she already produces in a normal reply -- no backend changes, no new
  "emit an artifact" tool, matching the issue's own "static rendering ...
  v1 target" framing.
- **No syntax highlighting.** Explicitly a nice-to-have in the issue text;
  `marked`'s default fenced-code rendering (a plain `<pre><code>` with a
  `language-*` class) is enough for v1 and leaves room for a highlighter
  later without a rendering-pipeline rewrite.
- **Static artifact view only.** No live/interactive artifacts with their
  own runtime state -- explicitly out of scope per the issue.

## Verified

- `windows-launcher/test/artifact-detector.test.js` (6 tests) and
  `desktop-client/test/artifact-detector.test.js` (6 tests, identical
  cases): no-fence text, short non-html fence ignored, html fence always
  flagged, long non-html fence flagged, only the first match returned,
  untagged fence treated as `text`.
- Full existing test suites, both apps, run one file at a time: 74 total
  in `windows-launcher` (9 files), 14 total in `desktop-client` (3 files).
  0 failures.
- `marked.parse()` output spot-checked directly in Node for headers,
  bold/italic, lists, and fenced code -- all correct.
