Chatterbox Turbo TTS service
============================

This folder contains two local TTS services for Mana. Fish Speech
(S1-mini) is Mana's actual **default** `TTS_PROVIDER` and runs separately
via `tools/api_server.py`, not from this folder — see
[docs/fish_speech_tts.md](../docs/fish_speech_tts.md). The two services here
are Mana's secondary/fallback voice paths:

- Kokoro ONNX is the faster primary test path on `http://127.0.0.1:5011`, and also runs as S1-mini's automatic fallback voice.
- Chatterbox Turbo is the higher-quality fallback path on `http://127.0.0.1:5010`.

Endpoints
---------
- `GET /health`
- `POST /synthesize`
  - accepts `{ "text": "...", "voice": "...", "speed": 1.0, "lang": "..." }`
  - `voice`, `speed`, and `lang` are optional per-request overrides

Environment
-----------
- `KOKORO_VOICE`
  - default: `jf_nezumi`
- `KOKORO_SPEED`
  - default: `1.18`
- `KOKORO_MANA_VOICE`
  - backend default: `jf_nezumi`
- Kokoro language routing keeps one Mana voice while switching language codes for English, Chinese Mandarin, Japanese, Korean, Russian, German, Spanish, and Malay.
- `CHATTERBOX_MODEL`
  - default: `turbo`
- `CHATTERBOX_DEVICE`
  - default: `cuda`
- `CHATTERBOX_VOICE_REF`
  - optional path to a reference voice clip
- `CHATTERBOX_EXAGGERATION`
  - default: `0.35`
- `CHATTERBOX_CFG_WEIGHT`
  - default: `0.45`
- `CHATTERBOX_TEMPERATURE`
  - default: `0.8`
- Natural Mana anime-sister starting preset
  - `CHATTERBOX_EXAGGERATION=0.34`
  - `CHATTERBOX_CFG_WEIGHT=0.34`
  - `CHATTERBOX_TEMPERATURE=0.66`
  - This aims for a youthful, crisp, natural anime delivery with a cool but soft tone.
- `CHATTERBOX_WARMUP`
  - default: `1`
  - set to `0` to skip startup warm-up
- `CHATTERBOX_WARMUP_TEXT`
  - default: `Ready.`

Performance
-----------
The service is configured for CUDA PyTorch by default. On a supported NVIDIA GPU, `/health` should report `"device": "cuda"`.

Startup warm-up is enabled by default so the first real Mana reply does not pay the full model load/CUDA initialization cost.

Start
-----
Kokoro:
```powershell
cd C:\ManaAI\Mana\tts-service
.\start_kokoro.ps1
```
The first Kokoro start downloads the ONNX model and voices into `tts-service\kokoro`.

Chatterbox:
```powershell
cd C:\ManaAI\Mana\tts-service
.\start.ps1
```
