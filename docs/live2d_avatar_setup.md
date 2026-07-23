# Live2D Avatar (Built-in VTuber Mode)

Mana can render a Live2D Cubism model directly inside the desktop avatar
overlay — no VTube Studio required. She drives it herself: idle motions while
waiting, lip sync from her own voice while speaking, and reaction motions
based on the emotion of each reply.

This doc covers the original `windows-launcher` implementation. The same
driver has also been ported into `desktop-client` (the installer-packaged
app) — `desktop-client/package.json`'s `fetch-live2d-core` / `fetch-sample-avatar`
scripts and `avatar\model\` folder work the same way there. Everything below
(tuning knobs, `mana-avatar.json`, env vars) applies to both.

## Setup

1. **Fetch the Live2D runtime** (one-time; it is proprietary and never
   committed to the repo):

   ```powershell
   cd C:\ManaAI\Mana\windows-launcher
   npm install
   npm run fetch-live2d-core
   ```

2. **Add a model** — two options:

   - **Don't have one yet?** Fetch Live2D's own free "Hiyori" sample model
     (Live2D Original Character, Free Material License Agreement — see
     [Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html)).
     This downloads straight from Live2D's CDN, the same way the "Download"
     button on their site does, and is never committed to or redistributed by
     this repo:

     ```powershell
     npm run fetch-sample-avatar
     ```

   - **Have your own model?** Copy the whole model folder (the one
     containing `*.model3.json`, `*.moc3`, textures, and motions) into:

     ```text
     C:\ManaAI\Mana\windows-launcher\avatar\model\
     ```

   Either way, the launcher auto-detects the first `.model3.json` it finds
   there (`fetch-sample-avatar` skips itself entirely if one is already
   present, so it never clobbers a model you dropped in), or you can point
   somewhere else explicitly:

   ```powershell
   $env:MANA_LIVE2D_MODEL = "D:\my-models\mana\mana.model3.json"
   ```

3. Start the launcher. The log prints `Live2D avatar loaded: ...` on success.
   If the runtime or model is missing, the avatar quietly falls back to the
   PNG sprites.

## How Mana drives the model

- **Idle**: plays the model's `Idle` motion group; breathing comes from the
  model itself, and eyes follow whatever that motion animates (e.g. a
  gradual doze-off close), so a generic blink never fights it.
- **Blinking + fixed iris size**: whenever she isn't idle, the launcher owns
  `ParamEyeLOpen`/`ParamEyeROpen` outright — no motion or expression gets a
  say — and drives them itself using the Live2D SDK's own randomized blink
  timer, rescaled so "open" holds at a fixed wide level
  (`MANA_LIVE2D_EYE_OPEN_SCALE`, default `1.5` ≈ 75% of the parameter's
  0–2 range — awake and expressive without a startled full-max stare). The
  eye-smile squint curve (`ParamEyeLSmile`/`RSmile` by default, override
  with `MANA_LIVE2D_SMILE_PARAMS`) and eyebrow movement (`ParamBrowLY`/`RY`/
  `LAngle`/`RAngle` by default, override with `MANA_LIVE2D_BROW_PARAMS`) are
  held neutral at the same time.
  Net effect: the iris reads as a constant size while she's talking or
  reacting, and only closes for an actual blink — nothing shrinks it by
  squinting, raising a brow, or a reaction motion's own baked animation.
  Idle is untouched on purpose — the sleepy motion's gradual doze-off close
  and brow relax stay exactly as authored.
  Some model exports ship an empty `EyeBlink` parameter group in
  `model3.json`, which leaves the SDK's blink timer with nothing to drive —
  the launcher backfills it with the standard `ParamEyeLOpen`/`ParamEyeROpen`
  names if it's missing or blank (override via `MANA_LIVE2D_EYE_BLINK_PARAMS`,
  comma-separated; set to an empty string to disable the backfill for a
  model that needs its own, which also opts that model out of the fixed-iris
  behavior above).
  All three `MANA_LIVE2D_*_PARAMS` vars share the same convention: unset
  uses the standard Cubism 4 names above (harmless even if a model lacks
  them — unknown ids are a no-op), comma-separated overrides them, and an
  explicit empty string disables that particular override entirely.
- **Speaking**: real-time lip sync — the launcher measures the loudness of
  Mana's TTS voice (~30 times/second) and drives the mouth parameter
  (`ParamMouthOpenY` by default; override with `MANA_LIVE2D_MOUTH_PARAM`).
  Mouth sensitivity is tuned for an exaggerated, expressive delivery:
  `MANA_LIVE2D_MOUTH_GAIN` (default `18`, double the old baseline of `9`)
  scales how wide the mouth opens for a given voice level — raise it for
  even bigger mouth movement, lower it toward `9` for the subtler original
  look. Values clamp at the parameter's max, so loud passages hold fully
  open rather than overshooting.
- **Emotions**: reply text is classified into a state (`talking` / `excited` /
  `angry` / `sad` / `disgusted`) and the matching motion group plays if the
  model has one — `Talk`/`Speak`, `Happy`/`Joy`, `Angry`/`Shake`, `Sad`/`Cry`,
  `Disgusted`/`Recoil`. Missing groups are skipped gracefully. Classification
  checks any kaomoji or emoji Mana used in the reply first (she picks these
  deliberately, e.g. a smiling face reads as `excited`, `(T_T)` reads as
  `sad`, flat "unimpressed" eyes like `(-_-)` read as `disgusted`), then
  falls back to a small set of English mood words for plain-text replies
  with neither (`renderer/reply-emotion.js`).
  A state with no matching motion/expression on the model (e.g. `talking` on
  a model with no dedicated speaking clip) simply keeps whatever motion or
  expression was already showing, instead of resetting to blank.
  The motion for whatever state she's currently in keeps auto-replaying for
  as long as that state persists (e.g. an `angry` reaction keeps looping
  instead of playing once and freezing partway through a long reply), the
  same mechanism the idle motion always used — it just can't loop mid-state
  for a state with no motion mapped, so it never overruns into the next one.
  Reaction motions often bake their own blink into the clip (e.g. `curious`
  blinks twice on its own); a looped motion replaying the exact same blink
  beat every cycle would read as mechanical, so — as covered above — the
  launcher overrides eye/brow parameters outright for every non-idle state
  rather than letting any clip's own curve drive them.
- **Disgust**: the built-in HuoHuo model has no "shrink the iris" parameter
  to animate (only eyeball X/Y position is rigged, not size), so `disgusted`
  is shown via the model's `white-eyes` expression instead — a blank,
  pupil-less stare, the usual anime shorthand for disgust/deadpan — rather
  than a literal size change. A model with an actual iris-size parameter can
  override `stateExpressions.disgusted`/`stateMotions.disgusted` in
  `mana-avatar.json` to use it instead.
- **Idle tilt**: if the model's idle motion pitches the head back sharply,
  Mana eases it toward a gentle side tilt instead (reads as dozing off)
  while idle only. Tune with `idleTiltDeg` (target `ParamAngleZ` side tilt,
  default `16`) and `idleMaxPitchDeg` (clamp on `ParamAngleY` pitch, default
  `8`) in `mana-avatar.json`, or the matching env vars for a quick test. A
  model whose idle motion doesn't pitch back at all can opt out with
  `idleTiltDeg: 0, idleMaxPitchDeg: 90` (90+ can never actually clamp a real
  head angle, so the correction becomes a no-op).
- **Zoom**: a button in the bottom-right corner of the avatar dock (main chat
  window only) cycles the framing through whole body → waist-up → bust-up.
  Per-model crop tightness can be tuned via `zoomFractions` in
  `mana-avatar.json` (fraction of model height kept on-screen for `waist`
  and `bust`; defaults `0.55` / `0.28`).

## Swapping models later

The model is fully drop-in:

1. Delete the old folder under `windows-launcher\avatar\model\` and copy the
   new model folder in (keep exactly one model; with several, the
   alphabetically first `.model3.json` wins).
2. Preview what Mana will do with it:

   ```powershell
   cd C:\ManaAI\Mana\windows-launcher
   npm run check-live2d-model
   ```

   This prints the detected model, its motion groups, expressions, whether
   the lip-sync parameter exists, and the state → motion/expression mapping.
3. Restart the launcher.

Models whose motions/expressions are loose VTube Studio-style files (not
registered in `model3.json`) are registered automatically.

### Per-model config (preferred)

Put a `mana-avatar.json` next to the model's `.model3.json` (it travels with
the model, so swapping stays clean — the whole personality/tuning setup for
a new avatar lives in this one file, no code or env vars required). Every
field is optional; anything omitted falls back to the built-in default:

```json
{
  "stateMotions": { "excited": "curious", "idle": "sleepy" },
  "stateExpressions": { "idle": "hug-pillow" },
  "randomMotions": [
    { "group": "spirit", "minIntervalMs": 120000,
      "maxIntervalMs": 480000, "states": ["idle"] }
  ],
  "zoomFractions": { "waist": 0.55, "bust": 0.28 },
  "mouthParam": "ParamMouthOpenY",
  "mouthGain": 18,
  "eyeOpenScale": 1.5,
  "eyeBlinkParams": ["ParamEyeLOpen", "ParamEyeROpen"],
  "smileParams": ["ParamEyeLSmile", "ParamEyeRSmile"],
  "browParams": ["ParamBrowLY", "ParamBrowRY", "ParamBrowLAngle", "ParamBrowRAngle"],
  "idleTiltDeg": 16,
  "idleMaxPitchDeg": 8
}
```

- `stateMotions` / `stateExpressions` map Mana's states (`idle`, `talking`,
  `excited`, `angry`, `sad`, `disgusted`) to this model's motion groups and
  expressions.
- The mapped idle motion becomes the model's auto-repeating idle loop.
- `randomMotions` play ambient motions at a random interval within the
  configured range, only while Mana is in one of the listed states.
- `zoomFractions` tunes how tightly the `waist`/`bust` zoom presets crop this
  model (`full` always shows the whole body). Values are the fraction of the
  model's total height kept on-screen — smaller means a tighter crop.
- `mouthParam`/`mouthGain`, `eyeOpenScale`, `eyeBlinkParams`/`smileParams`/
  `browParams`, and `idleTiltDeg`/`idleMaxPitchDeg` are the same knobs
  described above under "How Mana drives the model" — see the quick
  reference table below for the full list. For the three `*Params` array
  fields, an explicit empty array (`[]`) disables that override entirely,
  same convention as the env vars.

### Env overrides

Env vars win over the config file when both are set — handy for quick
experiments without editing the model folder:

```powershell
# state -> motion group (single name or array of candidates)
$env:MANA_LIVE2D_STATE_MOTIONS = '{"excited":"curious","idle":"sleepy"}'
# state -> expression name
$env:MANA_LIVE2D_STATE_EXPRESSIONS = '{"excited":"hug-pillow"}'
```

States: `idle`, `talking`, `excited`, `angry`, `sad`, `disgusted`. Overrides
are tried first, then the built-in names (`Idle`; `Talk`/`Speak`;
`Happy`/`Joy` and expressions `happy`/`joy`/`smile`; `Angry`/`Shake` and
`angry`/`mad`; `Sad`/`Cry` and `sad`/`cry`; `Disgusted`/`Recoil` and
`disgusted`/`white-eyes`).

### Tuning knobs quick reference

Priority is env var > `mana-avatar.json` field > hardcoded default. A model
swap only needs the `mana-avatar.json` column below (it travels with the
model); env vars are mainly for quick one-off experiments without editing
the model folder.

| `mana-avatar.json` field | Env var | Default | Purpose |
| --- | --- | --- | --- |
| — | `MANA_LIVE2D_MODEL` | auto-detect | Explicit path to a `.model3.json` outside `avatar\model\` (env-only: applies before a model is even chosen) |
| `mouthParam` | `MANA_LIVE2D_MOUTH_PARAM` | `ParamMouthOpenY` | Lip-sync parameter id |
| `mouthGain` | `MANA_LIVE2D_MOUTH_GAIN` | `18` | Lip-sync sensitivity (openness per voice level) |
| `eyeOpenScale` | `MANA_LIVE2D_EYE_OPEN_SCALE` | `1.5` | Non-idle "eyes open" level, as a multiplier on the blink timer's 0–1 output |
| `eyeBlinkParams` | `MANA_LIVE2D_EYE_BLINK_PARAMS` | `ParamEyeLOpen,ParamEyeROpen` | Parameters the auto-blink/fixed-iris system drives |
| `smileParams` | `MANA_LIVE2D_SMILE_PARAMS` | `ParamEyeLSmile,ParamEyeRSmile` | Parameters neutralized outside idle (fixed-iris) |
| `browParams` | `MANA_LIVE2D_BROW_PARAMS` | `ParamBrowLY,ParamBrowRY,ParamBrowLAngle,ParamBrowRAngle` | Same, for eyebrows |
| `idleTiltDeg` | `MANA_LIVE2D_IDLE_TILT_DEG` | `16` | Target `ParamAngleZ` side tilt while idle |
| `idleMaxPitchDeg` | `MANA_LIVE2D_IDLE_MAX_PITCH_DEG` | `8` | Clamp on `ParamAngleY` pitch while idle (`90`+ disables) |
| `stateMotions` | `MANA_LIVE2D_STATE_MOTIONS` | — | State → motion group override |
| `stateExpressions` | `MANA_LIVE2D_STATE_EXPRESSIONS` | — | State → expression override |
| `zoomFractions` | — | `{waist: 0.55, bust: 0.28}` | Zoom crop tightness |
| — | `MANA_AVATAR_FPS` | `30` | Render cap (env-only, not model-specific) |

For the three `*Params`/`*_PARAMS` fields: array or comma-separated list,
unset/omitted falls back to the default, an explicit empty array/string
disables that override entirely — a model that doesn't have (or doesn't
want driven) one of these parameter groups just turns it off.

## Performance

- Rendering is capped at 30 FPS (`MANA_AVATAR_FPS` to change) in the small
  avatar window, keeping GPU cost tiny next to a running game.
- The avatar window size/position still follows `MANA_AVATAR_WIDTH`,
  `MANA_AVATAR_HEIGHT`, `MANA_AVATAR_LEFT`, and `MANA_AVATAR_BOTTOM`.

## Licensing notes

- The Live2D **Cubism Core** runtime is proprietary (Live2D Proprietary
  Software License). It is downloaded from Live2D's official CDN at setup
  time and is git-ignored — do not commit or redistribute it with the repo.
- `pixi-live2d-display` and `pixi.js` are MIT licensed.
- Your model files in `avatar\model\` are also git-ignored by default so a
  personal model never lands in the public repo.

## VTube Studio

The existing VTube Studio integration (`docs/vtube_studio_setup.md`) still
works and is independent: use it if you prefer VTS rendering, or the built-in
avatar if you want everything inside Mana.
