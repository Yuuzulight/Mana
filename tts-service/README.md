Kokoro TTS service
==================

This folder contains Mana's local Kokoro ONNX TTS service. Fish Speech
(S1-mini) is Mana's actual **default** `TTS_PROVIDER` and runs separately
via `tools/api_server.py`, not from this folder — see
[docs/fish_speech_tts.md](../docs/fish_speech_tts.md). Kokoro here is
Mana's fast fallback voice path, on `http://127.0.0.1:5011`, used
automatically if S1-mini is unreachable.

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

Start
-----
```powershell
cd C:\ManaAI\Mana\tts-service
.\start_kokoro.ps1
```
The first start downloads the ONNX model and voices into `tts-service\kokoro`.
