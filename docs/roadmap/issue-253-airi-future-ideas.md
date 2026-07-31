# Issue 253: AIRI-inspired future ideas

## Status: 2 of 3 shipped (Live2D model validator; LLM-callable expression-tool system, see below); beat-sync head-sway remains scoped-not-implemented

Found while doing a deep read-through of Project AIRI's (moeru-ai/airi)
`stage-ui-live2d` package for issue #252 (randomized idle saccades +
spectral-centroid mouth shape, both shipped). Beat-sync head-sway is a real,
distinct idea that now has a concrete implementation shape (below) instead
of only a "why not now," but remains gated on an audio-source decision.

## 1. Beat-sync head sway

AIRI's `beat-sync.ts` drives a spring-physics head sway (critically-damped,
tunable `stiffness`/`damping`/`mass`) choreographed into named dance
patterns (`punchy-v`, `swing-lr`, `sway-sine`) triggered by detected music
beats, with auto BPM-based style switching between them.

### Why not now

Mana has no audio-capture surface that could feed this. Checked both
existing audio pipelines in `windows-launcher/renderer/renderer.js`: mic
capture for VAD/wake-word (`getUserMedia`, `AudioContext`/`createAnalyser`
feeding Silero VAD) and the lip-sync analyser on Mana's own TTS output
(`createMediaElementSource` + RMS/spectral-centroid). Neither captures
system/speaker audio or music playback, and neither is repurposable for
rhythm detection -- both are purpose-built for speech. A repo-wide search
for beat/BPM/now-playing-shaped code turns up nothing. Building the beat
detector (system-audio loopback or a music-file input, then real BPM
tracking) would be a much bigger lift than the head-sway animation itself.

### Concrete implementation shape (for whoever picks this up)

1. **Audio source, decided first, not assumed**: system-audio loopback
   capture (platform-specific, no existing Electron API surfaces this
   directly -- would need a native addon or a virtual-audio-device
   approach) vs. a narrower "user picks a music file/stream" input. The
   former matches AIRI's actual use case (reacting to whatever's playing);
   the latter is far cheaper to build but only reacts to audio Mana herself
   plays.
2. **Beat/BPM detection**: once real PCM samples exist, this is a solved
   problem (onset-detection + tempo-tracking algorithms are well documented
   and don't need porting from AIRI specifically) -- the actual work is
   almost entirely in step 1, not here.
3. **Animation port**: AIRI's `getTopPose`/`getBottomPose` spring-physics
   easing between named poses would port over fairly directly once a real
   beat signal exists -- this part was already scoped as low-risk in the
   original investigation and that hasn't changed.
4. **Not scheduled**: still gated entirely on deciding an audio-source
   approach; nothing here is committed to.

## 2. LLM-callable expression-tool system -- Shipped

Implemented per the concrete shape below, with one refinement made during
implementation: `setState`'s side effects (motion/mouth reset) stay gated on
an actual state-bucket change, but expression re-application now *also*
fires whenever a `preferredName` is supplied, even on a same-state reply --
otherwise a model-requested expression on a second consecutive same-state
reply would have been silently dropped by the pre-existing early-return
guard. `node-bot/ai/expression-tool-source.js` is the new tool source;
`buildAssistantReply` threads the chosen name through an `expression` field
(mirroring the existing `lastToolCalls` out-parameter pattern rather than
changing its return type); both apps' `/reply` handlers surface it; both
apps' `expressionForState`/`setState`/IPC chains prioritize it over the
automatic mood-based pick when present, falling back gracefully otherwise.

AIRI's `expression-store.ts` + `expression-tools.ts` expose
`expression_set`/`expression_get`/`expression_toggle`/
`expression_save_defaults`/`expression_reset_all` as actual tool calls the
chat model can invoke mid-conversation, with auto-reset durations, persisted
per-model defaults, and an LLM-exposure allowlist (`all`/`none`/`custom` per
expression group).

This is a materially different design from Mana's current approach
(`live2d-logic.js`'s `expressionForState`, a fixed state->expression lookup
table driven by `reply-emotion.js`'s emotion detection -- emoji/kaomoji
signals are checked first, with keyword regexes only as the fallback when
neither matches) -- it would let the model choose an expression directly
rather than only reacting to a coarse detected-emotion bucket.

### Correction to this doc's own earlier framing

An earlier pass over this doc claimed the real blocker was "node-bot has no
channel to reach the Electron renderer at all." That overstated the gap --
node-bot does run two live WebSocket servers (`caption-server.js`,
`tray-server.js`, both attached in `server.js`), but more importantly, **the
existing `/reply` HTTP round-trip already carries everything needed**: no
new channel turns out to be necessary at all. See the concrete shape below.

### Concrete implementation shape

1. **A new tool source**, `ai/expression-tool-source.js`, following the
   exact `{listToolSchemas, executeTool, isKnownToolName}` shape
   `ai/tool-source.js`'s `buildToolPolicy` composer expects (same pattern
   as `memory-tool-source.js`/`skill-tool-source.js`). `executeTool` for
   `expression_set(name)` does no side effect itself -- it just returns the
   chosen name, the same way any other tool's result flows back into
   `runToolAwareReply`'s `executedToolCalls` array
   (`ai/llama-server-runtime.js`, returned as `{content, toolCalls, rounds}`
   from the function itself).
2. **No approval-gate needed** -- unlike `skill__create`'s persisted write,
   picking a transient expression for this reply has no lasting effect and
   nothing to review.
3. **No name-validation layer needed either.** `expressionForState(state,
   availableNames, overrides)` (`live2d-logic.js`) already fuzzy-matches a
   preference list against whatever expression names the *loaded* Live2D
   model actually has (via `pickByPreference`), gracefully falling through
   to the model's default face on no match. `expression_set`'s tool schema
   can accept any free-form string and lean on that exact same fallback --
   node-bot doesn't need to know the current model's real expression list
   at all, since it's user-installed and varies per setup.
4. **Threading the result to the client is the only real wiring work**,
   and it reuses infrastructure that already exists end to end:
   - `server.js`'s `buildAssistantReply` currently discards
     `toolResult.toolCalls` except for a console log and a memory-store
     write (`lastToolCalls`, `server.js` -- used only for
     `acpMemoryStore.appendTurn`'s `toolCalls` field). It would need to also
     return the chosen expression name (if any `expression_set` call
     happened) alongside the reply text.
   - `server-routes.js`'s `POST /reply` handler currently responds with
     `res.json({ reply, ttsConfigured })`. Add one more field,
     `res.json({ reply, ttsConfigured, expression })`, only present when a
     tool call set one.
   - `renderer.js`'s existing `/reply` response handling (the same code
     path that already reads `data.reply`/`data.ttsConfigured`) reads the
     new `data.expression` field and calls `setAvatarState`'s
     `ipcRenderer.send("avatar:set-state", state)` path -- or a small
     sibling IPC message carrying the expression name directly -- instead
     of only ever deriving state from `detectReplyEmotion(text)`. The
     existing IPC relay in `main.js` (`avatar:set-state` ->
     `avatar:state`) and the avatar window's existing `setState()` ->
     `applyStateExpression()` -> `expressionForState()` -> `model.expression()`
     chain need no changes at all -- this is purely a new source feeding
     the same pipe, not a new pipe.
   - **No WebSocket work needed.** The two existing WebSocket servers
     (captions, tray) were considered and ruled out for this -- neither is
     currently consumed by the Electron apps, and the HTTP round-trip
     already used for every reply is the simpler, already-wired path.
5. **Both apps need the change** (per this project's own dual-app-parity
   rule) -- `windows-launcher/renderer/renderer.js` and
   `desktop-client`'s equivalent reply-handling code both read the `/reply`
   response and both drive their own avatar window.
6. **Estimate**: small. The tool source itself is a copy-adapt of an
   existing tool source (an afternoon); the response-payload threading
   touches ~4 files with one new field each; the riskiest part is making
   sure a mid-conversation expression override doesn't fight with the
   existing state-machine-driven idle/talking transitions (e.g. does the
   next idle tick immediately stomp the model's chosen expression?) --
   worth a short design note on precedence before writing code, not a
   blocker to scoping.

## 3. Live2D model validator -- Shipped (issue #255)

AIRI's `live2d-validator.ts` pre-flight-checks a Live2D model archive before
load: MOC3 header/version/size sanity, missing/case-mismatched file
references, basename collisions. It's built around AIRI's own zip-upload
flow (validating a `.zip` before extracting), which doesn't map directly
onto Mana's setup (`findModelJson` walks a local folder Electron's main
process already has direct filesystem access to -- no zip, no upload step,
no case-sensitivity risk from a zip's stored paths), so those specific
checks weren't ported.

The genuinely portable part *was* built: `validateModelReferences` in
`live2d-logic.js` (both apps) checks that `model3.json`'s referenced
Moc/Textures/Physics/Pose/DisplayInfo/Expression/Motion files -- including
VTube-Studio-style loose files, after `augmentModelSettings` registers them
-- actually exist on disk before `Live2DModel.from()` is called. Moc/Texture
misses are fatal (falls back to the sprite avatar with a clear log line,
same as "no model found"); a missing Physics/Pose/DisplayInfo/Expression/
Motion file is non-fatal (that one feature won't work, logged as a warning,
model still loads). Wired into `live2d-avatar.js` directly in
windows-launcher (real fs access in the renderer); in desktop-client it runs
in `resolve-model.js` (main process, since the context-isolated renderer
has no fs) and the result travels over IPC as `resolved.validation`.

## Not a commitment

Beat-sync head-sway (idea 1) remains unscheduled, still gated on an
audio-source decision before any code gets written. Revisit if a concrete
need shows up (a music-reactive feature request, or a user hitting a
confusing broken-model failure for idea 3's remaining zip-upload checks).
