# Issue 253: AIRI-inspired future ideas (parking lot, not scoped)

## Status: Investigated, not implemented -- revisit only if a concrete need shows up

Found while doing a deep read-through of Project AIRI's (moeru-ai/airi)
`stage-ui-live2d` package for issue #252 (randomized idle saccades +
spectral-centroid mouth shape, both shipped). These three ideas are real and
distinct but none are scoped, estimated, or committed to.

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
table driven by `reply-emotion.js`'s keyword-based emotion detection) -- it
would let the model choose an expression directly rather than only reacting
to a coarse detected-emotion bucket.

**Why not now**: this is a real feature, not a tweak. It needs a node-bot
tool-calling wire-up (the plumbing pattern already exists per issue #142's
programmatic tool calling for Deep Research), a decision on which
expressions are safe to expose to the model unsupervised, and UI for
reviewing/toggling exposure. Bigger scope than the other two items here;
deserves its own design pass if picked up.

## 3. Live2D model validator

AIRI's `live2d-validator.ts` pre-flight-checks a Live2D model archive before
load: MOC3 header/version/size sanity, missing/case-mismatched file
references, basename collisions. It's built around AIRI's own zip-upload
flow (validating a `.zip` before extracting), which doesn't map directly
onto Mana's setup (`findModelJson` walks a local folder Electron's main
process already has direct filesystem access to -- no zip, no upload step,
no case-sensitivity risk from a zip's stored paths).

**Why not now**: the specific problems AIRI's validator catches (zip
basename collisions, case-sensitivity mismatches from a zip's internal
paths) mostly don't apply to Mana's folder-based model discovery. The
genuinely portable part -- checking that `model3.json`'s referenced
Moc/Textures/Physics/Expression files actually exist on disk before
`Live2DModel.from()` is called, with a clear "here's what's missing"
message instead of a runtime failure -- could be a small, real
quality-of-life win for `docs/live2d_avatar_setup.md`'s custom-model flow.
Worth a small standalone issue if a user ever reports a confusing failure
when dropping in a broken VTube-Studio export; not worth building
speculatively today.

## Not a commitment

None of these are scheduled. Revisit if a concrete need shows up (a
music-reactive feature request, a tool-calling expression request, or a user
hitting a confusing broken-model failure).
