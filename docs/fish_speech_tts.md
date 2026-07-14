Fish Speech TTS

Mana can optionally call a local Fish Speech server as a TTS provider.

Recommended checkpoint: S1-mini
- Model: https://huggingface.co/fishaudio/s1-mini
- 0.5B parameters (a distilled version of Fish Audio's larger S1 model) —
  small enough to run comfortably on an 8GB-VRAM GPU, unlike Fish Audio's
  newer S2 Pro (5B params, ~10GB of BF16 weights alone; see
  docs/roadmap notes on issue #65 if that's ever revisited on stronger
  hardware).
- Gated on Hugging Face: you must accept the model's terms (sharing
  contact info, agreeing not to use it for DMCA-violating purposes)
  before you can download the weights.
- License: CC-BY-NC-SA-4.0 — non-commercial use only, share-alike,
  attribution required. Fine for personal use; do not distribute a
  commercial build of Mana with this checkpoint bundled.
- Supports emotion/tone markers in the input text (e.g. `(angry)`,
  `(whispering)`, `(laughing)`) and voice cloning via a reference
  sample — see `FISH_TTS_REFERENCE_ID` below.

Reference
- Fish Speech repository (serves the `/v1/tts` API Mana expects, via
  `tools/api_server.py`): https://github.com/fishaudio/fish-speech
- S1-mini model card: https://huggingface.co/fishaudio/s1-mini

Important notes
- Fish Speech is heavier than Kokoro and Chatterbox.
- The official setup path is separate from Mana and needs WSL2 (native Windows is
  not supported upstream) plus a CUDA GPU.
- **Latency is not real-time.** On an 8GB RTX 3070 Ti, a short reply
  (~150 semantic tokens) takes roughly 1-3 minutes end to end: reference
  encoding (under a second once warm), text-to-semantic generation
  (~2.5-2.7 tokens/sec), and audio decode. This is batch-style, not a live
  conversational voice — keep Kokoro as the default fast provider for
  actual voice interaction until this is meaningfully faster.
- **VRAM headroom is thin.** With the model loaded and idle, an 8GB card
  has only a few hundred MB free. This has been reliable for the verified
  Mitsuki reference clip below, but see the known issue further down.

Setting up S1-mini's server (verified working, WSL2 + Ubuntu)

1. Install `uv` inside WSL: `curl -LsSf https://astral.sh/uv/install.sh | sh`
2. Clone fish-speech **inside WSL's own filesystem** (e.g. `~/fish-speech`),
   not the Windows-mounted `tools/fish-speech` submodule — pip/uv installs
   on a `/mnt/c/...` path are drastically slower.
3. **Check out a pre-"S2 beta" commit.** As of this writing, fish-speech's
   `main` branch was refactored for Fish Audio's newer S2 model family, and
   that refactor broke loading S1-mini's checkpoint (`AutoTokenizer.from_pretrained`
   can't resolve the `dual_ar` model type, since it expects a different
   tokenizer file layout than S1-mini ships). Check out the last commit
   before that refactor: `git checkout 781bf1c` (commit message: "Finetune
   support of OpenAudio-S1 (#1115)"). Re-check the upstream repo's history
   before assuming this exact hash is still right if you're doing this much
   later — the goal is "the commit right before the two 'S2 beta' commits."
4. `uv sync --python 3.12 --extra cu129` (pick the `cuXXX` extra matching
   your driver's CUDA version, `nvidia-smi` reports it in the top banner).
   If `pyaudio` fails to build (needs a C compiler WSL doesn't ship by
   default), comment out the `"pyaudio"` line in `pyproject.toml` — it's
   only used by `tools/api_client.py` (an interactive CLI demo), not
   `tools/api_server.py`.
5. Download the checkpoint (requires accepting S1-mini's gate on its model
   page first, and a Hugging Face token with access):
   ```bash
   HF_TOKEN=your_token uv run huggingface-cli download fishaudio/s1-mini --local-dir checkpoints/fish-speech-s1-mini
   ```
6. Start the server:
   ```bash
   uv run tools/api_server.py \
     --llama-checkpoint-path checkpoints/fish-speech-s1-mini \
     --decoder-checkpoint-path checkpoints/fish-speech-s1-mini/codec.pth \
     --listen 127.0.0.1:8080
   ```
   WSL2 forwards `127.0.0.1` both directions by default, so Mana's Windows-side
   backend can reach it at `http://127.0.0.1:8080` with no extra networking setup.

Mana environment variables
- `$env:TTS_PROVIDER = "fish"` (this is now Mana's default provider — see
  server.js's header comment — so this line is only needed to be explicit
  or to override a different default).
- `$env:FISH_TTS_URL = "http://127.0.0.1:8080"`
- `$env:FISH_TTS_FALLBACK_PROVIDER = "kokoro"`
- `$env:FISH_TTS_REFERENCE_ID = "your-reference-id"` if you have a
  server-side pre-registered Fish Speech reference voice.
- `$env:FISH_TTS_REF_AUDIO` / `$env:FISH_TTS_REF_TEXT` for zero-shot
  in-context voice cloning instead — a local reference clip's path plus its
  **exact** transcript, sent with every request (see below). Takes priority
  over `FISH_TTS_REFERENCE_ID` when both are set.
- `$env:FISH_TTS_API_KEY = "your-token"` if your Fish Speech server requires a bearer token.

Cloning Mana's voice from an existing reference clip

Mana already has voice reference clips under `tts-service/references/`
(prepared for GPT-SoVITS, see docs/gpt_sovits_setup.md) — the same clips
work for Fish Speech's in-context cloning, since it just needs raw audio +
an accurate transcript of what's said in it.

**Verified working**: `gpt-sovits-mitsuki.wav` with its documented transcript:
```powershell
$env:FISH_TTS_REF_AUDIO = "C:\ManaAI\Mana\tts-service\references\gpt-sovits-mitsuki.wav"
$env:FISH_TTS_REF_TEXT = "In a quiet village where the sky brushes the fields in hues of gold, young Mia discovered a map leading to forgotten treasures."
```

**Known issue — `gpt-sovits-alice.wav` reproducibly hangs.** This clip is
actually Japanese (a multilingual Whisper transcription confirms it, not
the English `.en` model, which just hallucinates on it), so it needs a
Japanese transcript. Even with an accurate transcript, feeding this specific
clip to fish-speech's DAC encoder (`vq_manager.py`'s `encode_reference`)
reproducibly hangs for many minutes to hours while GPU VRAM climbs to the
card's ceiling (confirmed twice, on two independently fresh server
restarts — not stale CUDA state). The audio itself has no detectable
corruption (no clipping, no NaN-inducing anomalies, normal PCM data) — this
looks like an upstream fish-speech/DAC edge case, not a Mana integration
bug. **Do not use this clip** until upstream investigates; stick with the
Mitsuki reference.

Transcribing a new reference clip accurately matters — an inaccurate
transcript measurably hurts cloning quality (same lesson as GPT-SoVITS, see
docs/gpt_sovits_setup.md). Use Mana's local Whisper, and **use the
multilingual `ggml-base.bin` model, not `ggml-tiny.en.bin`**, if the clip
might not be English — the English-only model silently hallucinates
placeholder text like `(speaking in foreign language)` instead of failing
loudly:
```powershell
tools\whisper\Release\whisper-cli.exe -m tools\whisper\models\ggml-base.bin -f your-clip.wav -l ja -otxt -of transcript
```
(drop `-l ja` to auto-detect, or set the real language code once you know it).

Voice delivery: emotion/tone tags

S1-mini supports inline tags in the input text for delivery, separate from
*what* Mana says (that's already handled by her system prompts in
server.js, which already establish a "caring, bashful, occasionally
teasing anime little sister" personality in wording — see the base and
`CASUAL_SYSTEM_PROMPT` system prompts). Tags observed/documented on the
model card include `(angry)`, `(sad)`, `(whispering)`, `(shouting)`,
`(laughing)`, `(sobbing)` — use them sparingly, inline, e.g.
`"(shy) U-um... welcome home."` This is a manual text convention (there is
no automatic mapping from Mana's detected reply sentiment to a tag today);
treat it as an optional layer for future work if fine-grained emotional
delivery becomes worth the added prompt/text engineering, not something
Mana's replies do automatically yet.

Expected Fish Speech server
- Mana calls `POST /v1/tts` on `FISH_TTS_URL`.
- Mana expects the server to return audio bytes.
- Mana uses Kokoro or Chatterbox fallback if Fish Speech fails, unless `FISH_TTS_FALLBACK_PROVIDER=none`.

Quick test
- Start Fish Speech separately using its official instructions.
- Start Mana with `TTS_PROVIDER=fish`.
- Call Mana's backend synth endpoint:

```powershell
$body = @{ text = "Fish Speech test." } | ConvertTo-Json
Invoke-WebRequest -Uri "http://localhost:5005/synthesize" -Method Post -ContentType "application/json" -Body $body -OutFile "$env:TEMP\mana-fish-test.wav"
```

Fallback behavior
- `FISH_TTS_FALLBACK_PROVIDER=kokoro` uses Kokoro if Fish Speech is unavailable.
- `FISH_TTS_FALLBACK_PROVIDER=chatterbox` uses Chatterbox if Fish Speech is unavailable.
- `FISH_TTS_FALLBACK_PROVIDER=none` makes Fish failures visible immediately.
