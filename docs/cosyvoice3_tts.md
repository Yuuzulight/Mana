# CosyVoice3 (Mana's voice)

`TTS_PROVIDER=cosyvoice3` gives Mana her voice through
[Fun-CosyVoice3-0.5B-2512](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512)
on our own fast runtime (`tools/fast_tts`, #1454). It clones the voice from a
reference clip. Each sentence goes through CosyVoice's cross-lingual mode: the
language model gets no prompt text to continue, so the clip only gives the timbre
and the text can be in any language. That is how the approved English voice was
made. `tools/cosyvoice3_service.py` is a small loopback-only HTTP service:
node-bot posts each sentence to `POST /synthesize` and plays the WAV that comes
back, the same shape as [Qwen3-TTS](qwen3_tts.md).

## Numbers (RTX 5080, measured 2026-10-09 on `fast_tts`)

| | CosyVoice3 on fast_tts | CosyVoice3 as shipped |
|---|---|---|
| Time to speak 10 s of audio | ~4.7 s (0.45x real time) | ~10 s (1.0x) |
| Streaming first audio | 1.6-1.9 s | 3.4-3.6 s |
| Start (load + warm-up) | ~60 s | ~100 s |
| VRAM | ~+4.0 GB resident, ~5.1 GB at load | |

Qwen3-TTS is faster (0.7-0.9 s for a short sentence, ~2.7 GB), so keep it as the
other choice.

## Setup

`tools\cosyvoice\` is git-ignored except for `requirements.txt` and
`download_model.py`. It holds the CosyVoice checkout, the venv, the weights
(~5.4 GB) and the service logs.

```powershell
cd C:\ManaAI\Mana\tools\cosyvoice
git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git CosyVoice
git -C CosyVoice checkout 074ca6d
git -C CosyVoice submodule update --init --recursive
py -3.10 -m venv .venv
.venv\Scripts\python.exe -m pip install torch==2.7.1 torchaudio==2.7.1 --index-url https://download.pytorch.org/whl/cu128
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe download_model.py
```

An existing `tools\cosyvoice\env\python.exe` (a conda-style env) works too; the
launcher looks for `.venv` first, then `env`. The service runs offline
(`HF_HUB_OFFLINE=1`), so it never downloads anything.

Check the service without a GPU:

```powershell
tools\cosyvoice\.venv\Scripts\python.exe tools\test_cosyvoice3_service.py
```

## Switching to it

In `node-bot\.env`:

```
TTS_PROVIDER=cosyvoice3
COSYVOICE3_TTS_REF_AUDIO=C:\ManaAI\Mana\tts-service\references\alice-ref.wav
COSYVOICE3_TTS_REF_TEXT=the exact words said in that clip
```

The clip is 5-16 s of clean speech from one speaker, with its exact transcript.
Without `COSYVOICE3_TTS_REF_*` the service clones the `FISH_TTS_REF_*` clip.
Other settings (defaults in `node-bot\.env.sample`):

- `COSYVOICE3_TTS_URL` (default `http://127.0.0.1:5013`): node-bot calls it, the
  launcher health-checks it, and the service listens on its port (always bound
  to 127.0.0.1).
- `COSYVOICE3_TTS_MODEL_DIR`: the weights, if they're not under
  `tools\cosyvoice\models\Fun-CosyVoice3-0.5B-2512`.
- `COSYVOICE3_TTS_SEED`: a fixed sampling seed. Unset, every sentence is sampled fresh.
- `COSYVOICE3_TTS_EMOTION=off`: one pace for every emotion tag.
- `COSYVOICE3_TTS_FALLBACK_PROVIDER` (default `none`): with `none`, a reply it
  can't voice shows as text and the error surfaces. `kokoro` speaks it through
  Kokoro instead.

The native launcher starts the service when `TTS_PROVIDER=cosyvoice3`: at
BelowNormal priority, with a "CosyVoice3" row on the startup screen, no Fish
Speech, stopped on exit. Logs go to `tools\cosyvoice\service.out.log` /
`service.err.log`.

## Swapping between CosyVoice3 and Qwen3-TTS

Settings > Voice > "Voice engine" lists both. Picking one starts its service
(through the same resource coordinator as at launch), stops the other because
the two don't fit in VRAM next to the chat model, and only then tells node-bot to
use it, so a reply never goes to a voice that isn't loaded yet. CosyVoice3 takes
about a minute to load, Qwen3-TTS about 12 s; the dropdown is greyed while it
works, and a message says so when the voice didn't start. "Automatic" goes back
to whichever `TTS_PROVIDER` is set in `.env`. The pick lasts until node-bot
restarts, like the other engines in that list.

## Known limits

- English and Japanese: with the Alice reference, English comes back word for
  word in Whisper, while Japanese lines were often misheard, so use CosyVoice3
  for English first.
- Fine-tuning it on the clips (tried 2026-10-11 on Colab) made it worse: the tuned
  language model adds music-like sounds, even blended 25% into the base. The
  tuned flow alone was clean but isn't needed; the base model is what the voice
  uses.
- `fast_tts` falls back to CosyVoice's own runtime when it can't import, at about
  half the speed.
