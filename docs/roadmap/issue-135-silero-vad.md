# Issue 135: Replace RMS-Threshold Endpointing with Silero VAD

## Goal

Give `windows-launcher`'s continuous-listening loop a real speech/silence
signal instead of a raw energy threshold.

## Why

`recordUntilSilence()` decided whether the user was talking using
`MIN_SPEECH_RMS = 0.012` sampled every 150ms, plus a zero-crossing-rate
check as a second pass before sending audio to Whisper. That's a reasonable
heuristic, but it's still just an energy threshold -- it can't tell speech
apart from a loud fan, game background music, or a cough, and needs
per-environment tuning (see `docs/speech_recognition_improvement_plan.md`).

## Status: Implemented

- **`windows-launcher/renderer/silero-vad.js`**: wraps an injected
  `onnxruntime-web` instance running Silero VAD's streaming ONNX model.
  `ort` is passed in rather than required internally, since Electron's
  `nodeIntegration` renderer would otherwise resolve `require("onnxruntime-web")`
  to its Node-native export condition instead of the browser/WASM build --
  `ort` is loaded via a classic `<script src="../node_modules/onnxruntime-web/dist/ort.min.js">`
  tag in `index.html` instead, same as `pixi.js`/`pixi-live2d-display`.
- **`windows-launcher/scripts/fetch-silero-vad.js`**: downloads the ~2.3MB
  ONNX model from the official `snakers4/silero-vad` repo on setup, same
  pattern as `fetch-live2d-core.js` -- not committed to git.
- **Wired into `recordUntilSilence()`**: the `AudioContext` is created at
  16kHz explicitly (native browser resampling, no hand-written resampler),
  and each 150ms meter tick feeds the analyser's most recent 512 samples
  through Silero instead of computing RMS, using its speech probability
  (threshold 0.5, override via `MANA_VAD_THRESHOLD`) as the `hasHeardSpeech`
  signal. `voice-endpointing.js`'s timing logic (silence buffer, max
  duration, no-speech timeout) is unchanged -- only the "is this frame
  speech" signal changed.
- **Graceful fallback**: if the model fails to load or inference throws,
  `recordUntilSilence()` falls back to the original RMS check for the rest
  of the session instead of breaking voice input. `MANA_DISABLE_VAD=1`
  forces the RMS path even when the model is available.
- The post-hoc `getSpeechRejectReason` (RMS/peak/zero-crossing-rate check on
  the finished recording before it's sent to Whisper) is unchanged -- it's a
  separate second-layer filter, out of scope for this change.

### A real bug found and fixed during implementation

Silero's ONNX graph accepts an `input` tensor of any length without
throwing (dynamic axis) -- but the model was trained expecting the last 64
samples of the *previous* chunk prepended to each new 512-sample chunk
(confirmed against the official Python wrapper, `utils_vad.py`'s
`OnnxWrapper`). Feeding just the new 512 samples alone didn't error; it
silently produced near-zero speech probability for real recorded speech
(verified against three real voice samples, max probability 0.004-0.058,
zero frames ever crossing the 0.5 threshold). Adding the 64-sample context
window (carried across calls, reset per utterance, and copied rather than
viewed since the caller's frame buffer gets reused) fixed it: the same
three samples went from 0 detected speech frames to 82-91% of frames
correctly flagged as speech, max probability 0.999+.

### Deliberate simplifications

- `ponytail:` fixed 0.5 VAD threshold (env-overridable), not adaptive
  per-environment calibration -- revisit if 0.5 misbehaves in practice.
- No VAD in `desktop-client` -- it's pure hold-to-talk with no
  continuous-listening loop, so there's nothing for VAD to endpoint there.

### Verified

- `windows-launcher/test/silero-vad.test.js`: 9 new tests against a mocked
  `ort` -- correct input/state/sr tensor shapes including the context
  window, context threading across calls (including that mutating the
  caller's frame array afterward doesn't corrupt the saved context),
  recurrent state threading, `reset()` zeroing both state and context,
  session reuse, frame-length validation, and threshold comparison.
- Full `windows-launcher` suite (`node --test test/*.test.js`): 60/60 pass,
  no regressions.
- Live, end-to-end in a real browser (real `onnxruntime-web` WASM runtime,
  real downloaded model, real speech audio decoded via
  `OfflineAudioContext`): silence read ~0.0017 probability; three real
  speech samples read 82-91% of frames correctly flagged as speech (max
  probability 0.999+) after the context-window fix, versus 0% before it.
