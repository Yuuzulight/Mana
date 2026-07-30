# Issue 253: AIRI-inspired future ideas (parking lot, not scoped)

## Status: 1 of 3 shipped (Live2D model validator, see below); the other two remain un-scoped

Found while doing a deep read-through of Project AIRI's (moeru-ai/airi)
`stage-ui-live2d` package for issue #252 (randomized idle saccades +
spectral-centroid mouth shape, both shipped). Beat-sync head-sway and the
LLM-callable expression-tool system are still real, distinct ideas that
aren't scoped, estimated, or committed to.

## 1. Beat-sync head sway

AIRI's `beat-sync.ts` drives a spring-physics head sway (critically-damped,
tunable `stiffness`/`damping`/`mass`) choreographed into named dance
patterns (`punchy-v`, `swing-lr`, `sway-sine`) triggered by detected music
beats, with auto BPM-based style switching between them.

**Why not now**: Mana has no beat-detection pipeline at all -- no music
input, no BPM tracking, nothing to feed this. Building the beat detector
would be a much bigger lift than the head-sway animation itself, and Mana
isn't a music-reactive avatar today. The animation code itself
(`getTopPose`/`getBottomPose`/segment-based easing between poses) would port
over fairly directly once a real beat signal exists -- the gap is entirely
upstream of the animation.

## 2. LLM-callable expression-tool system

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

**Why not now**: this is a real feature, not a tweak, but the tool-calling
plumbing itself is actually cheap -- a single `expression_set(name)` tool
following the existing `{listToolSchemas, executeTool, isKnownToolName}`
shape (`ai/tool-source.js`'s `buildToolPolicy`, same pattern as
`memory-tool-source.js`/`skill-tool-source.js`) wouldn't need AIRI's own
per-expression allowlist/approval-gate machinery, since picking an
expression isn't a persisted write the way `skill__create` is. **The real
blocker is that node-bot currently has no channel to the Electron renderer
at all** -- `expressionForState` lives entirely client-side in
`live2d-logic.js`, and node-bot has no existing IPC/event bridge to reach
it. That bridge, not the tool schema or an allowlist UI, is the actual
scope this needs if picked up.

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

None of these are scheduled. Revisit if a concrete need shows up (a
music-reactive feature request, a tool-calling expression request, or a user
hitting a confusing broken-model failure).
