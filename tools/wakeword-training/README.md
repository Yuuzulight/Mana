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
2. **Negative examples** (`download_negative_features.py`) -- done.
   Downloads openWakeWord's own pre-computed negative feature files from
   HuggingFace (`davidscripka/openwakeword_features`) instead of
   assembling and featurizing a raw negative audio corpus from scratch --
   the same files their own training notebook uses: a 2,000-hour slice of
   the ACAV100M dataset (17.3GB) for training, plus an 11-hour validation
   set (185MB) for false-positive-rate estimation during training.
3. **Augmentation** (`download_rir_dataset.py`, `download_background_noise.py`)
   -- done. openWakeWord's trainer mixes room impulse responses and
   background noise/music under the positive clips so the model learns to
   recognize the wake word over reverb and noise, not just in a dry studio
   recording. Room impulse responses come from MIT's dataset (270 small
   WAV files, 8.4MB, direct download). Background noise/music comes from
   MUSAN (OpenSLR-17) instead of openWakeWord's own notebook sources
   (AudioSet, FMA) -- both changed shape since that notebook was written
   (AudioSet is now large parquet shards needing new dependencies to
   decode; FMA on HuggingFace is a remote-code-execution loading script,
   not plain files) and MUSAN was independently vetted by a research sweep
   (see the comment thread on #342) as a real, small, cleanly-licensed
   plain-WAV alternative. Only MUSAN's `noise/`+`music/` subsets are used
   -- its `speech/` subset isn't needed since phase 2 already covers bulk
   negative speech at far greater scale.
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

## Running phase 2

```powershell
cd tts-service
./venv/Scripts/python.exe ../tools/wakeword-training/download_negative_features.py
```

Streams both files to `data/negative/` (gitignored) with byte-size
verification against the expected download size, and resumes a partial
download if interrupted (falls back to a clean restart if the server
doesn't honor the resume request). Pass `--skip-training-set` to fetch
just the 185MB validation set, if you want to verify the pipeline without
the full 17.3GB training set. No new dependencies -- reuses `requests`,
already in `tts-service/requirements.txt`.

## Running phase 3

```powershell
cd tts-service
./venv/Scripts/python.exe ../tools/wakeword-training/download_rir_dataset.py
./venv/Scripts/python.exe ../tools/wakeword-training/download_background_noise.py
```

Writes to `data/rir/` (270 WAV files, 8.4MB) and `data/background/musan/`
(extracted `noise/`+`music/` subsets, gitignored). The background-noise
script downloads MUSAN's full 11GB `musan.tar.gz` first (byte-size
verified, resumable), then extracts only the two needed subsets -- the
archive itself is left on disk afterward in case you want to re-extract
`speech/` too later, but can be deleted once extraction is confirmed
good. No new dependencies -- both scripts reuse `download()` from
`download_negative_features.py` plus stdlib `tarfile`.
