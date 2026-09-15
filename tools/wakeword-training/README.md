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
4. **Training run** (`train_model.py`) -- done. Follows openWakeWord's own
   *manual* training recipe (`training_models.ipynb`) rather than the
   automated one, since the automated pipeline depends on Piper TTS for
   clip generation, which only supports Linux (we built our own generator
   in phase 1 instead). Mixes the positive clips with phase 3's background
   noise/music at random SNR, embeds them through openWakeWord's frozen
   feature backbone, and trains a small classifier head (the same 3-layer,
   32-unit architecture as openWakeWord's own notebook) against phase 2's
   precomputed negative features -- loaded memory-mapped, never fully into
   RAM, given the 17.3GB size. Evaluates false-positive rate against phase
   2's validation set, then exports to ONNX. Runs entirely on CPU: the
   RTX 5080 isn't actually usable here (torch's installed CUDA build
   predates Blackwell/sm_120 support, confirmed via `torch.cuda`'s own
   warning), but that's fine since the embedding backbone is frozen/
   pretrained (only ONNX inference, not training) and the classifier head
   itself is tiny.

   Two real bugs in `openwakeword` 0.6.0 itself, found and worked around
   (not assumed, confirmed against the installed package's own source):
   `openwakeword.data`'s module-level `import acoustics` fails on modern
   scipy (`scipy.special.sph_harm` was renamed to `sph_harm_y`), fixed
   with a same-signature alias since nothing here actually calls
   `acoustics`; and `mix_clips_batch` itself calls `.max(dim=1)` (torch
   syntax) on a variable that's already been converted to a numpy array
   two lines earlier, fixed with a vendored copy of just that function
   with `.max(axis=1)` substituted in.

   **Measured results, 14 Sep 2026** (5,000 augmented positive examples
   from the 168 base clips, 3,000 training steps, default 0.5 decision
   threshold): loss converges to ~0.0005-0.002, recall 0.95-1.0 on
   training batches. False-positive rate against phase 2's ~11-hour
   validation set is **7.2/hour at the default 0.5 threshold** -- well
   above openWakeWord's own pretrained-model target of 0.2/hour, as
   expected for a v1 model trained on 168 base recordings rather than
   their recommended 20,000-100,000. Raising the decision threshold
   trades recall for a lower false-positive rate without retraining:
   2.7/hour at 0.9, 1.0/hour at 0.99. Not yet good enough for a silently
   always-on deployment at the default threshold; phase 5's integration
   should expose the threshold as configurable rather than hardcoding
   0.5, and this is a reasonable place to revisit before/after real
   on-device testing -- more positive-clip diversity (more phrases,
   real human recordings alongside the synthetic ones) would likely help
   more than just raising the threshold further.
5. **Integration** -- done. Wired the trained ONNX model into the audio
   pipeline between VAD segment detection and the `/transcribe-only` call,
   in both launchers. Only gates the not-yet-awake path -- the existing
   text-based wake-word match (`WakeWordMatcher.cs` / `extractWakeCommand`)
   still has final say on whether the assistant actually wakes up, so a
   false acoustic trigger only ever wastes one Whisper call, it can never
   cause a false wake-up by itself. Both ports chain three ONNX models
   (melspectrogram -> embedding -> classifier) exactly as openWakeWord's
   own Python `AudioFeatures` class does, verified against the real
   models' actual shapes before writing either port, and both degrade
   gracefully (acoustic gate skipped, not a crash) if a model file is
   missing.
   - Native launcher: [PR #631](https://github.com/Yuuzulight/Mana/pull/631)
     -- `WakeWordClassifier.cs`, same `Microsoft.ML.OnnxRuntime` pattern
     as `SileroVadRunner.cs`. Threshold configurable via
     `ManaSettingsStore.WakeWordConfidenceThreshold` (default 0.9).
   - Electron launcher: [PR #632](https://github.com/Yuuzulight/Mana/pull/632)
     -- `wakeword-classifier.js`, same `onnxruntime-web`/injected-`ort`
     pattern as `silero-vad.js`. Threshold configurable via
     `MANA_WAKEWORD_THRESHOLD` (default 0.9).
   - Both PRs are based on `main` directly (not stacked on phases 1-4
     above) since they only need `mana.onnx`'s trained bytes, committed
     directly into each launcher's own `assets/wakeword/` directory, not
     any of this pipeline's code.

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

## Running phase 4

```powershell
cd tts-service
./venv/Scripts/python.exe -m pip install openwakeword pronouncing audiomentations torch_audiomentations speechbrain mutagen acoustics
./venv/Scripts/python.exe -c "import openwakeword.utils; openwakeword.utils.download_models()"
./venv/Scripts/python.exe ../tools/wakeword-training/train_model.py
```

New dependencies (all pip-only, no system packages): `openwakeword`
itself pulls in nothing new (`onnxruntime`/`scipy`/`scikit-learn`/
`requests`/`tqdm` are already in this venv); the rest are needed to
import `openwakeword.data` at all (module-level imports, even though
this script only calls two functions from it) -- `pronouncing` (pulls in
`cmudict`), `audiomentations` (pulls in `librosa`/`numba`), `torch_
audiomentations`, `speechbrain`, `mutagen`, `acoustics`. None pull in
TensorFlow or anything GPU-specific.

Writes `data/positive_features.npy` (cached -- deleted/regenerated
automatically if you change `--n-positive-examples`) and the final model
to `data/mana.onnx` (gitignored, same convention as `silero_vad.onnx`
elsewhere in this repo -- model files are fetched/built, not committed;
phase 5 will need its own hosting/fetch mechanism for this one). Takes a
few minutes on CPU at the default scale (5,000 positive examples, 3,000
training steps). Key flags: `--n-positive-examples`, `--steps`,
`--negatives-per-batch`, `--positives-per-batch`, `--output`.
