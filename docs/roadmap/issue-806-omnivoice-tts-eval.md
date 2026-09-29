# Issue 806: Evaluate OmniVoice As A Lighter Local TTS Provider

## Goal

Decide whether k2-fsa/OmniVoice should become an additional (or
replacement) local TTS provider next to Fish Speech S1-mini. The decision
rests on VRAM, latency and quality measured on Mana's own hardware, not on
the project's published numbers.

## Why

Fish Speech S1-mini is Mana's default voice. It is VRAM-heavy (~5 GB
loaded, see `docs/fish_speech_tts.md`) and holds that VRAM whether or
not it is speaking. That works against gaming-mode backoff.
[k2-fsa/OmniVoice](https://github.com/k2-fsa/OmniVoice) (March 2026,
613M params) claims:

- ~1.5 GB VRAM at 16-bit
- RTF as low as 0.025
- 600+ languages
- zero-shot voice cloning
- attribute-based "voice design" (no reference audio needed)
- inline non-verbal symbols (`[laughter]`, ...)
- pinyin/CMU-phoneme pronunciation correction

Issue #623 left coupling emotion to TTS prosody out of scope. The reason
was that S1-mini clones from reference audio instead of taking emotion
parameters. OmniVoice's voice design and non-verbal cues might remove that
limitation.

## Proposed Scope

- Evaluation only, not a commitment.
- Measure VRAM loaded and idle, and whether it can be released. This is
  the most important number.
- Measure real latency/RTF on short, medium and long Mana-style replies.
- Compare OmniVoice with S1-mini on the same reference clip and the same
  sentences.
- Confirm that voice cloning, voice design, non-verbal cues and
  pronunciation correction actually work, not just that the flags exist.
- Check how OmniVoice would fit `node-bot/tts-runtime.js`'s provider
  switch.
- Document the dependency footprint and licensing.

## Acceptance Criteria

- A documented before/after comparison on this hardware: VRAM
  loaded/idle/unloaded, latency/RTF, objective quality proxies,
  voice-design and non-verbal confirmation.
- A clear license/packaging note.
- A clear recommendation (new optional provider / new default / don't
  adopt) tied to the measured numbers.

## Method

**Hardware and conditions.** The run took place on 2026-09-29 on Mana's
own machine:

- RTX 5080 16 GB, Ryzen 7 5800X, 32 GB RAM, Windows 11
- normal desktop load, with Discord running and other agents running
  node/dotnet tests at the same time
- every model process at BelowNormal priority
- a watchdog polling RAM/VRAM every 3 s, ready to kill the process at
  88% RAM (never triggered)

Only one TTS model was loaded at a time. Baseline before each run was
~805-818 MiB VRAM used and ~53% RAM. All "+X GB" VRAM figures below are
deltas over that baseline, measured with `nvidia-smi` (whole-GPU
`memory.used`), so they include the CUDA context.

**OmniVoice setup.**

- Source: `k2-fsa/OmniVoice` @ `08be0b4` (package 0.2.1).
- Weights: `k2-fsa/OmniVoice` @ HF `c5fdb5c`. SHA-256 of both
  safetensors matched the HF LFS oids.
- Install location: `tools/omnivoice/` (gitignored).
- Python 3.12.13 venv with `torch==2.8.0+cu128` / `torchaudio==2.8.0+cu128`,
  the same build as Fish's `.venv-native`. It sees `sm_120`, and nothing
  was shared with Fish's venv.
- Loaded with the Python API, `from_pretrained(..., dtype=torch.float16)`.
- No `torch.compile` and no triton. FlashInfer was not tried.

**Fish setup.** Fish S1-mini was started exactly as
`tools/start_fish_speech_native.ps1` does it (`fish_speech_native_server.py`,
`--compile`, warm inductor cache). It was driven over `POST /v1/tts` with
the same body `buildFishTtsRequest` sends: `format wav`,
`latency normal`, `max_new_tokens 1024`, `chunk_length 300`,
`top_p 0.8`, `repetition_penalty 1.1`, `temperature 0.8`, and
`references: [{audio, text}]`. It was stopped the same way
`ManaProcessManager.StopProcess` stops it, by killing the process tree. A
plain `taskkill` without `/F` is refused for a console process. After
stopping, RAM and VRAM returned to baseline (53%, 817 MiB).

**Shared inputs.**

- Reference clip for both engines: `tts-service/references/gpt-sovits-mitsuki.wav`
  (9.1 s, the clip `docs/fish_speech_tts.md` documents as verified for
  cloning), with its documented transcript.
- Test replies, emotion tags already stripped as `synthesizeReply`
  receives them:
  - short: "Welcome back! Did you eat dinner yet?" (~2.5 s of audio)
  - medium: a 4-sentence "your cat is sick" reply (~9 s)
  - long: a 5-sentence build-failure reply (~21-25 s)
- Each length ran 3× after a warm-up.

**Quality proxies.** I did not literally listen to the output. Every
output WAV was:

- transcribed with Mana's whisper.cpp (`ggml-base.bin`) and scored for
  word error rate against the input text
- measured for clipping, peak/RMS, leading/trailing silence and the
  longest internal pause (frames 40 dB under peak)
- measured for pyin F0 median/IQR and voiced fraction
- measured for spectral flatness and the noise floor in the quietest
  in-speech frames

Below, anything not backed by one of these numbers is marked as needing
the user's ears.

## Findings

### Key numbers (RTX 5080, measured)

| | Fish S1-mini (current default) | OmniVoice (fp16) |
| --- | --- | --- |
| Startup to ready | 58 s (warm inductor cache; 150-255 s cold per docs) | 4.0 s load, no compile |
| VRAM loaded, idle | **+5.06 GB** (steady); +6.5 GB transient during load | +2.2 GB after load; **+5.3 GB idle after use if left alone** (PyTorch caching allocator, only 1.9 GB actually allocated) |
| VRAM idle with `torch.cuda.empty_cache()` after each request | n/a (can't release without parking) | **+2.28 GB**, flat across all 18 requests |
| VRAM peak while generating | +5.06 GB (no visible growth) | +2.4 GB (short) / +2.65 GB (medium) / **+3.35 GB (long)** with per-request `empty_cache`; one-off +5.1 GB while encoding a new reference clip |
| VRAM parked on CPU | +0.42 GB (`/admin/device?target=cpu`, 1.27 s; back in 0.97 s, **first request after unpark 8.2 s** while CUDA graphs re-record) | +1.08 GB (`model.to("cpu")`, 0.7 s; back in 0.31 s, next request normal 1.6 s) |
| VRAM after process exit | back to baseline | back to baseline |
| Host RAM (working set) | 3.0 GB peak at load, 2.1 GB settled, 2.5 GB after use; **6.9-8.0 GB while parked, 4.1 GB after unparking** (never went back to 2.5) | ≤2.38 GB peak at load, 2.37-2.38 GB settled; 3.3 GB while parked (4.3 GB peak during the move) |
| Short reply (2.5 s audio), wall / RTF | 0.89-1.02 s / 0.35-0.41 | ns32: 1.60-1.68 s / 0.60-0.67 · ns16: 0.82-0.96 s / 0.36 |
| Medium (9 s), wall / RTF | 1.65-1.78 s / 0.19 | ns32: 1.68-1.74 s / 0.18 · ns16: 0.82-0.84 s / 0.09 |
| Long (21-25 s), wall / RTF | 3.29-3.65 s / 0.16 | ns32: 1.61-1.71 s / 0.066 · ns16: 0.83-0.84 s / **0.033** |

`ns32`/`ns16` means `num_step` (32 is the default; 16 is what upstream
suggests for faster inference). OmniVoice's wall time is nearly **constant
in text length**: every unmasking step processes the whole utterance in
parallel. Short sentences therefore get the worst RTF. That matters
because Mana's streaming voice path synthesizes one sentence at a time
(`onSentence`), so the short-reply row is the one that shows up as
latency.

The vendor's claims against these measurements:

- **"~1.5 GB VRAM"** is optimistic. Weights alone allocate 1.94 GB,
  because the audio tokenizer stays fp32. The process sits at +2.28 GB
  idle and +3.35 GB peak.
- **"RTF 0.025"** is close: the best measured was 0.033 (ns16, long).
- The large VRAM win only exists if the integration calls
  `empty_cache()` after each request. A naive server idles at +5.3 GB,
  the same as Fish.

### Intelligibility and objective quality proxies (same clip, same sentences)

| | Fish short / med / long | OmniVoice ns32 short / med / long | OmniVoice ns16 |
| --- | --- | --- | --- |
| Whisper WER | 0 / 0.038 / 0.013 | 0 / 0 / 0.013 | 0 / 0 / 0 |
| Speaking rate (words/s; reference clip 2.56) | 3.02 / 3.13 / 3.77 | 2.99 / 2.96 / 3.18 | 3.48 / 2.92 / 3.11 |
| Output length for the long reply | 20.6 s | 24.6 s | 25.2 s |
| Longest internal pause | 0.28 / 0.32 / 0.34 s | 0.36 / 0.50 / **0.97 s** | 0.13 / 0.54 / 0.78 s |
| Clipping | none | none | none |
| Noise floor in quietest in-speech frames (dB rel. peak; reference -48.6) | -54 / -51 / -49 | -46 / **-34** / -40 | -41 / **-34** / -46 |
| Spectral flatness (reference 0.027) | 0.035-0.046 | 0.05-0.11 | 0.05-0.11 |
| F0 median (reference 212 Hz) | 215-230 Hz | 217-242 Hz | 204-244 Hz |

**Measured:**

- Both engines are fully intelligible to Mana's own STT. Fish's one miss
  was "I'm sure" → "And sure". OmniVoice's one miss was "one file" →
  "one fire" in one ns32 take.
- Neither clips.
- Both clones land within ~30 Hz of the reference clip's median pitch.
- OmniVoice paces closer to the reference speaker's slower rate. Fish
  speaks ~20-45% faster than the reference.
- OmniVoice's pauses between sentences run longer, up to ~1 s.
- OmniVoice's gaps between words are measurably **not as clean**. Its
  noise floor in the quietest in-speech frames sits 3-17 dB above Fish's
  and the reference's, and its spectral flatness is about 2× higher.
  That is consistent with audible breath or hiss between words.

**Needs the user's ears:**

- whether that raised noise floor is audible hiss or just breathiness
- whether the ~1 s inter-sentence pauses sound natural or draggy
- which engine sounds more like the reference speaker. No speaker-embedding
  model was installed, so there is no objective speaker-similarity number.
- overall naturalness

A Japanese line ("おかえりなさい！今日はどうだった？") transcribed
exactly from OmniVoice. Fish's transcribed as "…今日はどうだ" (2.28 s
vs 3.01 s), which may be a clipped ending. Confirm by listening.

### Voice cloning

- **Works, at parity with S1-mini on these proxies.** The WER, pitch and
  pacing figures are in the table above.
- A clone prompt encodes in 0.59 s. It can be saved to disk
  (`VoiceClonePrompt.save`), so Mana's reference clip only has to be
  encoded once. That also skips the one-off +5.1 GB encode transient.

### Voice design (no reference audio)

**Works; confirmed by measurement, not just by the flag.** All outputs
had WER 0. F0 medians followed the requested attributes:

| instruct | F0 median |
| --- | --- |
| male, middle-aged, low pitch | 162 Hz |
| female, young adult, low pitch | 245 Hz |
| female, young adult, high pitch | 361 Hz |
| female, child | 426 Hz |

`whisper` produced genuinely unvoiced speech: voiced fraction 0.00 and no
F0 found, against 0.5-0.75 for normal speech.

Limits that matter for #623:

- **The attribute vocabulary has no emotions.** `instruct="female, sad"`
  and `"female, happy"` are rejected with `ValueError: Unsupported
  instruct items`. The only categories are gender, age, pitch, whisper,
  English accent and Chinese dialect.
- **`instruct` does not apply on top of a cloned voice.**
  `voice_clone_prompt` + `instruct="whisper"` came out fully voiced
  (voiced fraction 0.67, like a normal clone). So Mana's cloned voice
  cannot be "designed" per sentence.

### Non-verbal cues

**Work, including on the cloned voice.** Each cue measurably added sound:

- `[laughter]` +1.09 s, `[sigh]` +0.77 s, `[dissatisfaction-hnn]` +1.94 s
  over the untagged 3.63 s line
- the added sound is not transcribed as words
- the interjection cues are audible as interjections: `[surprise-oh]` →
  "Oh,", `[surprise-wa]` → "Wah,", `[dissatisfaction-hnn]` → "Huh,",
  `[confirmation-en]` → "Hmm.", `[question-en]` → "Hen,"
- a mid-sentence `[laughter]` also worked
- the rest of the line stayed intact (WER 0-0.08)

A per-sentence mapping from Mana's tags was tried on a real reply:
`[sigh] Oh no, your cat is sick? [question-en] Is she still eating okay?
[laughter] She'll be fine…`. It produced 8.5 s against 6.1 s untagged,
with the same WER. So **per-sentence LLM tags could drive these cues**
with a small lookup:

| Mana tag | OmniVoice cue |
| --- | --- |
| sad, disappointed | `[sigh]` |
| happy | `[laughter]` |
| surprised, excited | `[surprise-oh]` / `[surprise-wa]` |
| questioning | `[question-en]` |
| angry, disgusted | `[dissatisfaction-hnn]` |
| thinking | `[confirmation-en]` ("hmm") |
| neutral, embarrassed, wink | none |

What this does **not** give is emotional *tone of voice*. A sad sentence
gets a sigh before it, not a sad delivery. So #623's limitation is only
**partly** removed: OmniVoice adds non-verbal sounds on the cloned voice,
but there is no emotion parameter for the voice itself.

Whether the laugh or sigh sounds natural or uncanny needs the user's
ears. The WAVs to compare are listed below.

For comparison, S1-mini's own documented inline markers were run on the
same line: `(sad)`, `(angry)`, `(laughing)`, `(surprised)`,
`(whispering)`. They barely moved any proxy:

- duration within ±0.5 s of the untagged line
- F0 median 209-224 Hz against 227 Hz untagged
- `(whispering)` stayed fully voiced (0.75)
- nothing extra was transcribed

On this checkpoint, Fish's markers are much weaker than OmniVoice's cues
(the user's ears should confirm).

### Pronunciation correction

- **CMU phonemes: works.** `I have a [K AE1 T] at home.` was transcribed
  as "I have a **cat** at home.", against "dog" for the plain text. That
  is direct proof the override is honoured.
- A hand-written override for Mana's own name, `[M AA1 N AA0]`, was heard
  as "Mona" and slowed the line (0.96 s gap). The plain "Mana" was already
  transcribed correctly, so the name doesn't need an override. If one is
  ever needed, `pronunciationLexiconStore` could emit CMU brackets for
  this provider.
- **Pinyin: the mechanism works.** `…严重SHE2本了…` was spoken as a
  syllable (Whisper wrote 捨), not spelled out letter by letter. Whether
  the tones are right needs a Mandarin speaker.

### Integration fit with `node-bot/tts-runtime.js`

- **The provider branch itself is shallow.**
  `synthesizeWithConfiguredProvider` would need one more
  `else if (provider === "omnivoice")` that calls the existing `postJson`
  helper against an `OMNIVOICE_TTS_URL`. `synthesizeReply` would need one
  more block with an `OMNIVOICE_TTS_FALLBACK_PROVIDER`. Both mirror the
  existing `gpt_sovits` branch, and no other plumbing is needed for plain
  speech.
- **OmniVoice ships no HTTP server**, only a CLI and a Gradio demo. Mana
  would need a thin FastAPI wrapper in the shape of
  `tts-service/kokoro_service.py`. That wrapper has to:
  - load the model once
  - load a saved `VoiceClonePrompt` of Mana's reference clip
  - generate at `num_step=16`
  - call `torch.cuda.empty_cache()` after each request, without which
    the VRAM win disappears
  - expose a device-park route like Fish's `/admin/device`, or just be
    stopped and restarted, since reload takes 4 s and needs no compile
- **Driving non-verbal cues from emotion tags needs a little extra
  plumbing.** Tags are stripped before TTS today. The per-sentence emotion
  is already available where the streaming path calls
  `onSentence(sentence, emotion)` (`server.js`). It would need to be
  passed as an optional argument through `server.js`'s `synthesizeReply`
  → `ttsRuntime.synthesizeReply` and mapped to a cue only for this
  provider. That is 2-3 call sites, not a redesign.
- **Gaming mode could be simpler than with Fish.** At +2.3 GB idle (vs
  +5.1 GB), with a 4 s cold start and no compile trace, OmniVoice could
  simply be stopped while a game runs and restarted afterwards. That
  would replace the park/unpark dance, whose measured side effect on Fish
  is 7-8 GB of host RAM while parked.

### Dependency footprint

- **Python and packages.** Python ≥3.10 (3.12 used), with
  `torch 2.8.0+cu128` / `torchaudio`, `transformers ≥5.3` (5.17
  installed), `accelerate`, `pydub`, `soundfile`, `librosa`, `numpy` and
  `huggingface_hub`. Upstream also declares `gradio`, `tensorboardX` and
  `webdataset`. They are only needed for the demo and training;
  inference ran without them (installed with `--no-deps`).
- **Build dependencies.** No triton or `torch.compile`, which means none
  of the Windows fixes Fish needed.
- **Disk.** The venv is 7.5 GB, mostly the CUDA torch wheels. `uv` could
  not hardlink them from its cache on another drive.
- **Weights.** 3.27 GB total, not gated:
  - `model.safetensors`, 2.45 GB, fp32 (cast to fp16 at load)
  - `audio_tokenizer/model.safetensors`, 0.81 GB
  - tokenizer and config files
- **Whisper model.** `openai/whisper-large-v3-turbo` is downloaded only if
  `ref_text` is omitted. Mana always has the transcript, so it never
  needs it.

### License and packaging (verified from the actual files)

Summary: **OmniVoice has no license advantage over Fish.** The weights
are non-commercial, as S1-mini's are (CC-BY-NC-SA-4.0), and they add
Higgs/Llama-3 terms on top. "Apache-2.0" covers only the code.

- **Code:** `LICENSE` in the GitHub repo is Apache-2.0, and `pyproject.toml`
  says the same.
- **Model weights:** the HF model card says *"The pre-trained model is
  licensed under the CC-BY-NC due to constraints from its training data
  (e.g., Emilia)."* That makes them non-commercial, like S1-mini. The only
  difference from S1-mini is that there's no share-alike clause.
- **Bundled audio tokenizer** (`audio_tokenizer/`, Boson's Higgs Audio v2
  tokenizer, required for inference): **Boson Higgs Audio 2 Community
  License**, which is derived from the Llama 3 Community License. Its
  terms:
  - distributing it, or a product that uses it, requires shipping the
    license and a prominent "Built with Higgs Materials… Meta Llama 3"
    notice
  - use must follow the Llama 3 Acceptable Use Policy
  - outputs must not be used to improve other LLMs
  - more than 100k annual active users requires a separate license from
    Boson

Packaging is fine for personal and local use. It is not a path to a
commercially distributable voice. Like Fish, it is safest shipped as a
separate user-installed component, with the Higgs/Llama notice in Mana's
docs if it is ever offered.

## Recommendation

**Adopt as a new optional provider (`TTS_PROVIDER=omnivoice`), not as the
new default yet.**

For:

- **VRAM.** Idle is +2.28 GB against Fish's +5.06 GB (-55%), and peak is
  +3.35 GB, provided the wrapper calls `empty_cache()` after each request.
  This is the number that matters most for gaming-mode coexistence.
- **Startup.** 4 s with no compile, against 58 s warm and 150-255 s cold.
- **Latency at `num_step=16`.** Equal to or faster than Fish at every
  length: 0.85 s vs 0.9 s short, 0.83 s vs 1.7 s medium, 0.83 s vs 3.4 s
  long.
- **Intelligibility.** WER is 0 on every ns16 test sentence.
- **#623.** Non-verbal cues verifiably work on the cloned voice and map
  cleanly from Mana's per-sentence tags. That is a real, if partial, step
  on #623.

Against, or not yet settled:

- **Default step count is too slow for short sentences.** At
  `num_step=32` a short sentence takes 1.65 s against Fish's 0.9 s, and
  Mana streams short sentences. The provider must run at ns16.
- **Noise between words.** OmniVoice's noise floor between words is
  measurably 3-17 dB higher than Fish's and the reference's, and its
  inter-sentence pauses run up to ~1 s. Whether that is audible hiss,
  and whether the clone sounds as much like Mana as S1-mini's, can only
  be settled by listening.
- **Licensing is not better.** CC-BY-NC weights plus the Higgs/Llama
  tokenizer terms.
- **Emotion is sounds, not tone.** Voice design cannot express emotions
  and does not combine with cloning, so #623 gets non-verbal sounds, not
  emotional delivery.

Suggested order:

1. The user listens to the WAV pairs below, especially the medium/long
   clones and the `nv_*` cues.
2. If the noise floor and pauses are acceptable, build the thin server,
   the provider branch and an opt-in emotion-to-cue mapping.
3. Revisit making OmniVoice the default after it has run live, since the
   VRAM and startup numbers favour it.
4. Separately from this decision, the Fish measurements surfaced a side
   finding, now #807. Parking S1-mini on CPU takes host RAM to
   6.9-8.0 GB, not the documented ~4-4.5 GB. After unparking it stays at
   ~4.1 GB instead of returning to ~2.5 GB, and the first request after
   unparking takes 8.2 s.

Not measured here:

- behaviour under real GPU contention from a running game
- FlashInfer / CUDA-graph acceleration (upstream claims 2-2.9×)
- streaming (sub-sentence) output. OmniVoice returns a whole utterance.

## Related

#623, #213, #65, #807
