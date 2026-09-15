# Custom "Mana" wake-word model (issue #342)

Replaces the current keyword/fuzzy-match wake-word check (which runs
*after* full Whisper transcription, on every VAD-triggered utterance) with
a dedicated, always-on, near-zero-CPU acoustic classifier that gates
transcription instead of following it. See #342 for the full background.

This is a multi-phase pipeline. Each phase ships as its own PR.

## Phases

1. **Synthetic positive clips** (`generate_positive_clips.py`) -- done.
   Synthesizes the wake phrase across Kokoro's 28 English voices (American
   + British, female + male) and 3 speed variants using the Kokoro model
   already bundled for `tts-service/`. Fully local, no network access, no
   new model download.
2. **Negative examples** -- not started. openWakeWord's own training
   recipe distributes pre-computed negative feature sets (general speech +
   noise, already featurized) specifically so custom wake-word models don't
   need their own raw negative audio corpus -- use those rather than
   assembling one from scratch.
3. **Augmentation** -- not started. openWakeWord's trainer has built-in
   room-impulse-response and background-noise augmentation
   (via `audiomentations`) using its own hosted impulse-response/noise
   clips -- reuse that rather than hand-rolling augmentation.
4. **Training run** -- not started. openWakeWord's trainer (PyTorch) on
   the positive clips + negative features from phases 1-3, producing an
   ONNX model. This machine's RTX 5080 covers the compute.
5. **Integration** -- not started. Wire the trained ONNX model into the
   audio pipeline between VAD segment detection and the `/transcribe-only`
   call, in both launchers:
   - Native launcher: same `Microsoft.ML.OnnxRuntime` pattern as
     `SileroVadRunner.cs` (persistent `InferenceSession`, 16kHz frames).
   - Electron launcher: same `onnxruntime-web` pattern as `silero-vad.js`.

## Running phase 1

```powershell
cd tts-service
./venv/Scripts/python.exe ../tools/wakeword-training/generate_positive_clips.py
```

Requires `tts-service`'s own Kokoro model files to already be present
(`tts-service/kokoro/kokoro-v1.0.int8.onnx` + `voices-v1.0.bin`) and its
venv to have `kokoro-onnx`, `soundfile`, `numpy`, and `scipy` installed --
all of which `tts-service/requirements.txt` already pulls in, so no new
dependencies were added for this phase.

Writes 16kHz mono PCM WAV clips to `data/positive/` (gitignored -- this is
generated training data, not source). Run with `--phrase "Mana" --phrase
"Hey Mana"` (the default) or override with your own `--phrase` list,
`--speeds`, or `--out-dir`.
