Chatterbox Turbo TTS service
============================

This folder contains two local TTS services for Mana.

- Kokoro ONNX is the faster primary test path on `http://127.0.0.1:5011`.
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
