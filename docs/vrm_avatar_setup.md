# VRM Avatar (3D Model Option)

Mana can also render a VRM (3D) model instead of Live2D, driven by the
exact same emotion-state and RMS-lip-sync signals that already drive the
Live2D avatar. VRM is preferred over Live2D whenever a model is
configured; without one, Mana falls back to Live2D exactly as before.

This is bring-your-own-VRM -- like Live2D's sample avatar, any bundled
default would need the same license-compliance check before shipping, so
there's no sample model included here.

## Setup

Drop your `.vrm` file into the same model folder Live2D already uses:

```
windows-launcher\avatar\model\your-avatar.vrm
```

(Also gitignored, same as Live2D's model files -- see the root
`.gitignore`'s "Live2D runtime ... and personal avatar model" entry,
which already covers this whole folder.)

Or point at a file anywhere else via an env var:

```powershell
$env:MANA_VRM_MODEL = "C:\path\to\your-avatar.vrm"
```

If both a `.vrm` file and a Live2D `.model3.json` are present, VRM wins.
To force Live2D even with a VRM file present, don't set `MANA_VRM_MODEL`
and remove/move the `.vrm` file out of `avatar\model\`.

## What's driven, and what isn't yet

- **Emotion state** (idle/talking/excited/angry/sad/disgusted -- the same
  states Live2D already reacts to) maps onto VRM's standard expression
  presets (`happy`/`angry`/`sad`/`relaxed`; VRM has no native "disgusted",
  so that maps to `relaxed` rather than inventing a non-standard
  expression name).
- **Lip sync** drives the VRM `aa` (mouth-open) expression from the exact
  same RMS-to-mouth-openness math Live2D uses (`avatar/lip-sync.js`,
  shared between both renderers).
- **Zoom** (full/waist/bust) works via camera framing instead of a 2D
  crop, using the model's head bone position to compute where to look.
- **Not yet implemented**: spring-bone/physics simulation tuning, idle
  head-tilt/gaze drift (Live2D has both -- explicitly out of scope for
  this first VRM pass per the issue that added it), and per-model tuning
  config (`mana-avatar.json` is Live2D-only for now).

## Where this lives

Both windows-launcher avatar surfaces support VRM: the always-on-top
overlay window (`avatar/renderer.js`) and the inline avatar in the main
chat window (`renderer/renderer.js`). `desktop-client` doesn't have VRM
support yet -- Live2D itself was ported there incrementally after
landing in `windows-launcher` first, and VRM is expected to follow the
same path whenever that port happens.

## Verification note

No real VRM model/GPU rendering was exercised in the environment that
built this -- verified via unit tests on the pure logic
(`avatar/vrm-logic.js`: model file discovery, avatar-kind fallback
resolution, state-to-expression mapping) and by confirming `three`/
`@pixiv/three-vrm` load correctly via Node's CommonJS `require()` (both
ship a CJS build reachable this way). The actual three.js rendering
pipeline in `avatar/vrm-avatar.js` -- scene setup, GLTF/VRM loading,
camera framing, the render loop -- is not covered by automated tests and
was not visually verified this session. Worth a manual load-a-real-VRM
check (does it render, does lip sync move the mouth, do the emotion
states swap expressions, does zoom frame correctly) before relying on
this.
