# Model-initiated vision look (#417)

## Context

Mana's vision path today is reactive only: `/vision/describe` fires on
the `Ctrl+Alt+M` hotkey, and the screen-sensing plugin runs a separate,
opt-in ambient-glance loop on its own timer. Issue #417 asks for a third
path: the model itself, mid-reply, decides a screenshot would help
answer the question and requests one — "language-intent-based
activation," per the issue's cited prior art (my-neuro).

The issue frames this as a straightforward addition of a new tool
source alongside `node-bot/ai/expression-tool-source.js` and
`node-bot/ai/skill-tool-source.js`. That framing undersells the real
gap.

## Key finding that shapes this design

Screenshot capture is Electron-only: `windows-launcher/main.js`'s
`ipcMain.handle("screen:capture-primary", ...)` (around line 1356) is
the only place a screenshot actually gets taken, via
`desktopCapturer.getSources(...)`. `node-bot` (where the model's
tool-calling loop runs, inside `buildAssistantReply`) has no
screenshot capability of its own — every existing vision path
(`/vision/describe`, `/screen/read`, `/screen-sensing/glance`) only
ever *receives* an already-captured base64 image in the request body;
none of them can produce one.

So a `vision_look` tool called mid-reply, server-side, cannot make a
literal request-and-wait-for-a-screenshot happen unless something new
bridges server and client in real time. There is no existing
bidirectional channel that does this: `tray-notifier.js`/`tray-server.js`
is a deliberately one-directional, fire-and-forget broadcast (server →
client only, no response expected), and every other client/server
interaction in this codebase is either a plain HTTP request/response or
a client-side poll loop (`/perf/status`, `/health`).

This makes #417 architectural, not bounded: it needs a small new
subsystem (a request/response bridge with correlation and timeouts),
not just a new tool-source module.

## Rejected alternative

**HTTP long-polling**, piggybacking on the renderer's existing 3-second
`/perf/status` poll cycle: the renderer would check each poll for "is
there a pending capture request for me," capture and respond if so. Zero
new transport, reuses established infra. Rejected because up to 3
seconds of dead air before the client even notices the request directly
undermines the feature's own premise — a model deciding *mid-reply* to
glance at the screen should feel closer to instant, not add a
multi-second stall on top of vision inference and TTS.

## Design

### 1. `node-bot/vision-capture-bridge.js` — new, purpose-built request/response channel

A small WebSocket server, structurally similar to `tray-server.js` but
distinct from it — kept separate rather than extending
`tray-notifier.js`'s existing channel, because that module's whole
contract is "fire-and-forget, no response expected." Bolting
correlation IDs and pending-promise bookkeeping onto it would blur a
currently single-purpose module into two purposes at once.

Exports:

```js
function createVisionCaptureBridge({ timeoutMs = 10000 } = {}) {
  // WS server the client connects to (mirrors tray-server.js's shape).
  // requestCapture(): generates a requestId, pushes
  // {type: "capture-request", requestId} over the socket, returns a
  // Promise held in a pending-requests Map (same Map-per-key shape as
  // sessionToolCounts/sessionTokenUsage elsewhere in this codebase).
  // The Promise resolves when resolveCapture(requestId, image) is
  // called (see the new HTTP endpoint below), or rejects after
  // timeoutMs if nothing arrives -- no client connected, client too
  // slow, or the user denied a screen-capture permission prompt.
  async function requestCapture() { ... }
  function resolveCapture(requestId, image) { ... }
  function rejectCapture(requestId, reason) { ... }
  return { requestCapture, resolveCapture, rejectCapture, wss };
}
```

No persistence, no retry -- a single capture attempt per tool call,
same "accept a clean failure over silent hanging" philosophy the rest
of this codebase's fire-and-forget helpers already use (`notifyTray`,
`sessionTokenUsage`).

### 2. `node-bot/ai/vision-tool-source.js` — new tool source

Mirrors `expression-tool-source.js`'s exact shape (`listToolSchemas`,
`executeTool`, `isKnownToolName`), per the tool-source contract in
`node-bot/ai/tool-source.js`.

```js
const TOOL_SCHEMAS = [{
  type: "function",
  function: {
    name: "vision__look",
    description:
      "Look at the user's screen right now and describe what's on it. " +
      "Use this when seeing the screen would genuinely help answer the " +
      "question -- not for every turn.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "What to look for or ask about the screen.",
        },
      },
      required: ["prompt"],
    },
  },
}];
```

`executeTool("vision__look", { prompt })`:

1. Gate: `getVisionStatus()` (local vision model installed) — same
   check `/vision/describe` already applies. Not available → return
   `{status: "error", error: "no local vision model available"}` (JSON
   string, matching `skill-tool-source.js`'s error-return convention;
   never throws for an expected/user-facing failure).
2. Gate: screen-sensing plugin's opt-in
   (`isPluginEnabled(screenSensingPlugin, activePluginSettingsStore)`,
   same helper/pattern already used for browser-automation's tool
   source at `server.js:4329`). Not enabled → same error shape,
   `"vision look requires the screen-sensing plugin to be enabled"`.
   Reusing this toggle (rather than a new, separate one) is a
   deliberate simplification: both this and the ambient-glance loop are
   "let Mana see the screen without a hotkey," and one setting for both
   is one less thing to find and turn on.
3. `await visionCaptureBridge.requestCapture()` — on timeout/rejection,
   same graceful error-string return (`"could not capture the screen: <reason>"`).
4. On success, call the existing `runVisionReply(prompt, [image])` and
   return `{status: "ok", description: <text>}`.

### 3. `windows-launcher/main.js` — client-side relay

New `connectVisionCaptureBridge()`, structurally identical to
`connectTrayNotifications()` (same reconnect-on-close pattern, same
`TRAY_SOCKET_RECONNECT_DELAY_MS`-style constant). On a `capture-request`
message: `mainWindow.webContents.send("vision:capture-request", requestId)`.

### 4. `windows-launcher/renderer/renderer.js` — capture and respond

New `ipcRenderer.on("vision:capture-request", async (event, requestId) => {...})`
handler: calls the *already-existing*
`ipcRenderer.invoke("screen:capture-primary")` (the exact same call
`handleVisionHotkey`/the ambient-glance loop already make), then
`POST /vision/capture-result` with `{ requestId, image }`.

### 5. `node-bot/server.js` — new endpoint + tool-source registration

`POST /vision/capture-result`: validates `requestId`/`image`, calls
`visionCaptureBridge.resolveCapture(requestId, image)`, returns `{ok:
true}`. No auth beyond whatever the rest of the local-only HTTP surface
already relies on (loopback-bound server, same trust boundary as every
other route here).

`createVisionLookToolSource(...)` added to the tool-source array in
`buildAssistantReply` (`server.js:4322`, alongside
`createExpressionToolSource()`), needing `getVisionStatus`,
`runVisionReply`, `visionCaptureBridge`, and
`activePluginSettingsStore`/`screenSensingPlugin` threaded in — all
already in scope in that function, same as every other tool source
built there.

### Error handling and degradation

- No client connected to the WS bridge at all → `requestCapture()`
  rejects immediately (no point waiting the full timeout) with a
  distinguishable reason (`"no client connected"`), surfaced to the
  model as a plain, honest error string it can relay
  ("I don't have a way to see your screen right now").
- Client connected but never responds (permission denied, capture
  failed client-side, etc.) → times out at `timeoutMs` (10s default),
  same graceful error shape.
- Multiple concurrent `vision_look` calls (unlikely in one reply, but
  possible across concurrent sessions) → each gets its own `requestId`
  in the pending-requests Map, so they don't cross-resolve.

## Testing

- `vision-capture-bridge.js`: pure-logic unit tests for
  `requestCapture`/`resolveCapture`/`rejectCapture`/timeout behavior,
  using a fake WS connection (no real network), mirroring how
  `tray-notifier.test.js` already tests `tray-notifier.js` without a
  real socket.
- `vision-tool-source.js`: unit tests for each gate (no vision model,
  plugin disabled, capture timeout, capture success), injecting a fake
  `visionCaptureBridge`/`runVisionReply`/`getVisionStatus`, mirroring
  `expression-tool-source.test.js`'s existing style.
- `server.js` wiring: an integration test exercising
  `POST /vision/capture-result` resolving a real pending
  `requestCapture()` Promise, similar in spirit to this session's
  `session-token-usage-server-wiring.test.js` (fake upstream / real
  `createApp()`).
- `main.js`/`renderer.js`: consistent with this codebase's existing
  convention, Electron-glue code in these two files has no direct unit
  test coverage (same as `proactive-notifications.js`'s wiring in
  `main.js`, or `formatPerfStatus` in `renderer.js`) — the pure logic
  (bridge, tool source) is what's tested; the glue is verified by
  reading + the full pipeline being exercised through the other tests
  above wherever possible.
