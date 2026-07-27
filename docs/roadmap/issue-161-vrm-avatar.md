# Issue 161: VRM (3D) Avatar Support

## Goal

Add VRM as a second avatar option alongside Live2D, reusing the existing
emotion-reaction/lip-sync signal pipeline (the same audio-driven mouth
movement and emotion-state triggers already wired for Live2D) rather than
building a parallel animation system from scratch. The root README
already named this as a planned future alternative with no tracking
issue -- this closes that gap.

## Status: Implemented (`windows-launcher/avatar/vrm-avatar.js` + `vrm-logic.js`, both windows-launcher avatar surfaces)

- **`three` + `@pixiv/three-vrm`** added as new `windows-launcher`
  dependencies -- the standard combination for VRM rendering. Both ship a
  CommonJS build reachable via plain `require()` (verified directly:
  `require("three")`, `require("three/addons/loaders/GLTFLoader.js")`,
  `require("@pixiv/three-vrm")` all resolve without a bundler), matching
  how this codebase already loads everything else via `require()` in
  Electron's nodeIntegration renderer context.
- **`avatar/lip-sync.js`** (new): `rmsToMouth`/`smoothMouthValue` moved
  out of `live2d-logic.js` into their own module so the VRM renderer
  shares the *exact* same signal math instead of inventing a second
  curve -- this is what "reuse the existing signal pipeline" means
  concretely. `live2d-logic.js` re-exports them unchanged, so no existing
  caller or test needed to change.
- **`avatar/vrm-logic.js`** (new, pure/testable): `findVrmFile` (mirrors
  `live2d-logic.js`'s `findModelJson`, recursive `.vrm` search),
  `resolveAvatarKind({vrmPath, live2dPath})` (VRM preferred, Live2D
  fallback, "none" if neither -- no sprite/PNG fallback is invented,
  matching how Mana already degrades when the Live2D model itself is
  missing), `vrmExpressionForState(state)` (maps the same
  idle/talking/excited/angry/sad/disgusted states Live2D already reacts
  to onto VRM's standard expression presets -- `happy`/`angry`/`sad`;
  `disgusted` maps to `relaxed` since VRM has no native disgusted preset).
- **`avatar/vrm-avatar.js`** (new): `createVrmAvatar({canvas, width,
  height, env})` returns `null` when no VRM model is configured (callers
  fall back to Live2D), otherwise the *same* interface shape
  `createLive2dAvatar` already returns --
  `{setState, setMouthTarget, setZoom, cycleZoom, getZoom, stop}` -- so
  both renderers are interchangeable to their callers. Loads the VRM via
  `GLTFLoader` + `VRMLoaderPlugin`, drives the `aa` expression from the
  shared lip-sync math, swaps expression presets on `setState`, and
  frames the camera per zoom level using the model's head-bone world
  position (mirrors Live2D's crop-to-the-head zoom in spirit, expressed
  as a 3D look-at height instead of a 2D crop).
- **Wired into both windows-launcher avatar surfaces**: the always-on-top
  overlay (`avatar/renderer.js`, now with a second `#vrm` canvas
  alongside `#live2d`, whichever loads gets unhidden) and the inline
  avatar in the main chat window (`renderer/renderer.js`'s
  `initWindowAvatar`, which reuses the single existing canvas since only
  one renderer is ever active at once). Both try VRM first, fall back to
  Live2D on failure or if nothing is configured.
- **Model discovery**: same folder Live2D already uses
  (`windows-launcher/avatar/model/`, already gitignored) -- a `.vrm` file
  dropped there is found automatically; `MANA_VRM_MODEL` overrides with
  an explicit path.
- **`docs/vrm_avatar_setup.md`** (new): setup, what's driven vs. not yet,
  and the verification-limitation disclosure. Root `README.md` updated
  from "planned as a future alternative" to reflect that it now exists.

## Deliberate simplifications

- **No bundled sample VRM model.** Bring-your-own, per the issue's
  explicit scope (same license-compliance reasoning as Live2D's Hiyori
  sample).
- **No spring-bone/physics simulation tuning.** Per the issue's explicit
  scope -- basic rendering + lip sync + emotion blend shapes only.
- **No idle head-tilt/gaze drift for VRM.** Live2D has both (from earlier
  avatar-polish work), but replicating that level of procedural idle
  motion for a 3D humanoid rig is a distinct, larger effort than "get
  basic rendering + lip sync + emotion working" -- left for later.
- **`desktop-client` untouched.** The issue explicitly allows landing in
  "whichever surface is simpler first, matching how Live2D itself was
  ported incrementally" -- Live2D landed in `windows-launcher` first, then
  `desktop-client` followed as a separate piece of work. VRM follows the
  same path.
- **No per-model `mana-avatar.json`-style tuning config for VRM yet** --
  Live2D's tuning knobs (mouth gain, idle tilt, etc.) don't have a VRM
  equivalent; the zoom/expression defaults are hardcoded constants for now.

## Verification note

No real VRM model or GPU/WebGL rendering was exercised in the environment
that built this. What *is* verified:
- `avatar/vrm-logic.js`'s pure functions (file discovery, fallback
  resolution, state-to-expression mapping) via direct unit tests.
- `avatar/lip-sync.js`'s extraction didn't break `live2d-logic.js`'s
  existing re-exports (`live2d-logic.test.js` still passes in full).
- `three` and `@pixiv/three-vrm` load correctly via plain Node
  `require()` (confirms the CJS build path works in this codebase's
  `require()`-based renderer convention) -- `avatar/vrm-avatar.js` itself
  also loads without throwing.

What is *not* verified: the actual three.js rendering pipeline in
`vrm-avatar.js` (scene setup, GLTF/VRM loading against a real file,
camera framing, the per-frame render loop, expression/lip-sync driving a
real model's blend shapes). Worth a manual load-a-real-VRM check (does it
render, does lip sync move the mouth, do emotion states swap expressions,
does zoom frame correctly, does the Live2D fallback still work when no
VRM is configured) before relying on this -- the same category of gap
this session already disclosed for #150 (no real browser launched) and
#154 (no real yt-dlp/ffmpeg/whisper-cli).

## Verified

- `windows-launcher/test/vrm-logic.test.js` (10 tests): `.vrm` file
  discovery (direct match, recursion, deterministic first-match, missing
  root), avatar-kind resolution (vrm-preferred, live2d-fallback, none),
  state-to-expression mapping (known states, idle/talking/unknown ->
  null), and the re-exported lip-sync functions.
- `windows-launcher/test/live2d-logic.test.js` (25 tests): unaffected by
  extracting `rmsToMouth`/`smoothMouthValue` into `lip-sync.js`.
- Full `windows-launcher/test/*.test.js` suite (84 tests across all 10
  files, run one file at a time): no regressions from the new
  dependencies or the two renderer.js wiring changes.
