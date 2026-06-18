Chatterbox Turbo TTS service
============================

This service runs Chatterbox locally and exposes a small HTTP API for Mana.

Endpoints
---------
- `GET /health`
- `POST /synthesize`

Environment
-----------
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

Start
-----
```powershell
cd C:\ManaAI\Mana\tts-service
.\start.ps1
```

This service listens on `http://127.0.0.1:5010`.
