# Qwen3-TTS (Mana's voice)

`TTS_PROVIDER=qwen3tts` gives Mana her voice through
[Qwen3-TTS-12Hz-0.6B-Base](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base).
It runs via [faster-qwen3-tts](https://github.com/andimarafioti/faster-qwen3-tts)
with CUDA graphs and clones her voice from the same reference clip and
transcript that Fish Speech uses. `tools/qwen3tts_service.py` is a small
loopback-only HTTP service: node-bot posts each sentence to `POST /synthesize`
and plays the WAV that comes back. See #891.

## Numbers (RTX 5080, measured 2026-09-30)

| | Qwen3-TTS 0.6B | Fish S1-mini |
|---|---|---|
| Start (load + CUDA graphs) | ~12 s | ~58 s |
| VRAM resident | ~+2.7 GB | +5.1 GB |
| VRAM peak while speaking | 3.3–3.9 GB | |
| Host RAM (working set) once ready | ~0.12 GB (~2.5 GB while starting) | |
| Short sentence | 0.7–0.9 s | |
| Streaming first audio (not used yet) | 0.2–0.3 s | |

Host RAM, measured on 2026-09-30 with FFXIV running (#904): the process
reaches a ~2.5 GB working set while loading. Most of that is CUDA/cuDNN DLL
pages and import- and load-time heap that speaking never touches again. Once
it's warm, the service hands that memory back to Windows with
`EmptyWorkingSet`, and sets a 256 MB soft minimum so the ~0.12 GB it does use
isn't trimmed again. System RAM in use at ready dropped by ~1.5 GB (89.5% to
84.7% of 32 GB). Latency stayed within noise, except the first reply after
start, which pays ~0.1 s to page back in. Private bytes (commit, ~6.7 GB, mostly CUDA's reservations)
don't change, and don't need physical RAM.

These didn't help, so they aren't used:
- `CUDA_MODULE_LOADING=LAZY`: torch already loads lazily.
- `gc.collect()` after load: there are no CPU tensors, and the safetensors
  files aren't left mapped.
- cuDNN off: saved only ~0.15 GB, and speech got slower.
- No CUDA graphs: saved nothing, and speech was ~10x slower.

WER/CER was equal to or better than Fish in English, Japanese, Chinese,
Korean, Russian, German and Spanish. The resident figure depends on two
settings in the service:

- `max_seq_len=1024` for the static cache.
- `torch.cuda.empty_cache()` after every request.

Without them it's roughly double.

Limits:
- **Malay** isn't a Qwen3-TTS language. Malay text is sent with `auto` and
  comes out read as best the model can.
- **Emotion tags** (#909) only change her pace. The 0.6B Base model has no
  emotion control on a cloned voice: I measured faster-qwen3-tts's `instruct`
  ("speak sadly", "speak excitedly", ...) and got no change in pace or pitch
  beyond take-to-take noise. So the service resamples each sentence by its
  tag instead: excited 7% faster (and ~1.1 semitones higher), happy 4%,
  sad 7% slower (~1.2 semitones lower), and so on (`EMOTION_RATES`), at
  ~5 ms per sentence. `QWEN3_TTS_EMOTION=off` turns it off. Real emotional
  delivery would need emotion-specific reference clips of her voice or a
  model with instruct on cloned voices (e.g. Fun-CosyVoice3).

## Setup

`tools\qwen3-tts\` is git-ignored except for its `requirements.txt`. It holds
the venv, the weights (~2.5 GB) and the service logs.

```powershell
cd C:\ManaAI\Mana\tools\qwen3-tts
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\hf.exe download Qwen/Qwen3-TTS-12Hz-0.6B-Base --local-dir models\Qwen3-TTS-12Hz-0.6B-Base
```

`requirements.txt` pins versions that are known to work together:
- torch 2.11.0+cu128
- faster-qwen3-tts 0.5.2
- qwen-tts-hf 0.1.1.post1
- transformers 5.17.0

The service runs offline (`HF_HUB_OFFLINE=1`), so it never downloads anything.

Check the service without a GPU:

```powershell
tools\qwen3-tts\.venv\Scripts\python.exe tools\test_qwen3tts_service.py
```

## Switching to it

In `node-bot\.env`:

```
TTS_PROVIDER=qwen3tts
```

That's all when `FISH_TTS_REF_AUDIO`/`FISH_TTS_REF_TEXT` are already set: the
service clones the same clip. Optional settings (defaults shown in
`node-bot\.env.sample`):

- `QWEN3_TTS_REF_AUDIO` / `QWEN3_TTS_REF_TEXT`: a different reference clip and
  its exact transcript.
- `QWEN3_TTS_URL` (default `http://127.0.0.1:5012`): node-bot calls it, the
  launcher health-checks it, and the service listens on its port (always
  bound to 127.0.0.1).
- `QWEN3_TTS_MODEL_DIR`: the weights, if they're not under
  `tools\qwen3-tts\models\`.
- `QWEN3_TTS_FALLBACK_PROVIDER` (default `none`): with `none`, a reply that
  Qwen3-TTS can't voice (it failed or isn't up yet) shows as text and the
  error surfaces. `kokoro` speaks it through Kokoro instead.

The native launcher starts the service when `TTS_PROVIDER=qwen3tts`:
- It uses the venv's python at BelowNormal priority.
- It shows a "Qwen3-TTS" row on the startup screen and waits for it to be ready.
- It doesn't start Fish Speech.
- It stops the service on exit.
- Logs go to `tools\qwen3-tts\service.out.log` / `service.err.log`.

To run the service by hand, set the same variables in your shell and run
`tools\qwen3-tts\.venv\Scripts\python.exe tools\qwen3tts_service.py`.

## Gaming

Qwen3-TTS stays loaded and keeps speaking while a watched game runs. There's no
switch to Kokoro and no stop/restart, unlike Fish, which hands over to Kokoro
and parks its weights in RAM. With ~2.7 GB of VRAM it fits next to FFXIV and
the 4B gaming chat model on a 16 GB card.

## Known break: the RoPE shim

qwen-tts-hf 0.1.1.post1 has a RoPE compat shim that reads `config.rope_theta`.
transformers 5.17's `MimiConfig` (the speech tokenizer) keeps that value in
`config.rope_parameters` instead, so loading fails with `AttributeError`.
`patch_rope_theta()` in the service copies the value across at call time, and
nothing on disk changes. Once either package fixes it, `rope_theta` exists and
the shim passes straight through. If a newer qwen-tts-hf or transformers
breaks loading in some other way, pin back to `requirements.txt`.

## Licence

- Qwen3-TTS code and weights: Apache-2.0.
- qwen-tts-hf: Apache-2.0.
- faster-qwen3-tts: MIT.

Unlike Fish S1-mini's weights (CC-BY-NC-SA), there's no non-commercial limit.

## Switching back to Fish

Set `TTS_PROVIDER=fish` in `node-bot\.env`, or remove the line (Fish is the
default), and restart Mana. The launcher then starts Fish Speech again and
leaves Qwen3-TTS alone. Nothing else needs undoing.
