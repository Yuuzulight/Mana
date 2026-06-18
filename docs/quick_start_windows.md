Quick start (Windows, current path)

This document describes the supported setup as of June 18, 2026.

Architecture
- `windows-launcher` runs the Electron UI.
- The Electron main process starts `node-bot/server.js`.
- `node-bot` calls local `whisper.cpp` and `llama.cpp` binaries.
- `node-bot` can call a local Chatterbox Turbo TTS microservice to synthesize reply audio.
- The renderer records audio in the browser, converts it to WAV, and sends it to `http://localhost:5005/transcribe`.

Project goal
- This repository is for a local AI assistant running on your own machine.
- The current implementation focuses on the core voice loop: listen, transcribe, generate a reply, and speak it back.

1) Install prerequisites on Windows
   - Windows 11
   - Node.js LTS from https://nodejs.org
   - Git for Windows
   - `ffmpeg` on `PATH` if you want server-side audio conversion fallback
   - A Windows build of `whisper.cpp`
   - A Windows build of `llama.cpp`
   - Python 3.10+ for the Chatterbox TTS service
   - Local model files for Whisper and Llama

2) Configure backend environment variables
   - Open PowerShell and set:
     - `$env:WHISPER_BIN = "C:\path\to\whisper-cli.exe"`
     - `$env:WHISPER_MODEL = "C:\path\to\ggml-model.bin"`
     - `$env:LLAMA_BIN = "C:\path\to\llama-cli.exe"`
     - `$env:LLAMA_MODEL = "C:\path\to\model.gguf"`
     - `$env:TTS_PROVIDER = "chatterbox"`
     - `$env:CHATTERBOX_TTS_URL = "http://127.0.0.1:5010"`
     - `$env:CHATTERBOX_MODEL = "turbo"`
     - `$env:CHATTERBOX_VOICE_REF = "C:\path\to\evil-style-reference.wav"`
     - `$env:CHATTERBOX_EXAGGERATION = "0.35"`
     - `$env:CHATTERBOX_CFG_WEIGHT = "0.45"`
     - `$env:CHATTERBOX_TEMPERATURE = "0.8"`

   Notes:
   - `WHISPER_BIN` should point to the Whisper CLI executable you want to use.
   - If `WHISPER_BIN` is unset or wrong, Mana will also try common local paths under `tools\whisper\`.
   - `LLAMA_BIN` should point to the Llama CLI executable you want to use.
   - `TTS_PROVIDER=chatterbox` tells Mana to use the local Chatterbox TTS microservice.
   - `CHATTERBOX_VOICE_REF` should point to a short reference clip that matches the direction you want.
   - Lower `CHATTERBOX_CFG_WEIGHT` and a moderate `CHATTERBOX_EXAGGERATION` help push the voice toward a sharper, more stylized agent delivery.
   - If `LLAMA_BIN` or `LLAMA_MODEL` is not set, the backend returns a placeholder reply so you can still test audio capture and transcription.
   - If the Chatterbox service is not running, the UI still shows the text reply but will not play synthesized audio.

3) Install launcher and backend dependencies
   - In PowerShell:
     - `cd C:\ManaAI\Mana\node-bot`
     - `npm install`
     - `cd C:\ManaAI\Mana\windows-launcher`
     - `npm install`

4) Install the Chatterbox TTS service
   - In PowerShell:
     - `cd C:\ManaAI\Mana\tts-service`
     - `.\start.ps1`

   On first run this installs the Python dependencies and downloads the model.

5) Start the launcher
   - In PowerShell:
     - `cd C:\ManaAI\Mana\windows-launcher`
     - `npm run start`

   The launcher starts `node-bot` automatically and will also try to start the Chatterbox TTS service when `TTS_PROVIDER=chatterbox`.

6) Use Push-to-Talk
   - Hold the `Push to talk (hold)` button, speak, then release.
   - The UI shows the transcript and model reply.
   - If Chatterbox is running, the reply is synthesized and played back by the app.

Troubleshooting
- If the UI reports `Local backend not reachable`, check that `node-bot` started successfully and that nothing else is using port `5005`.
- If transcription fails immediately, verify `WHISPER_BIN` and `WHISPER_MODEL`.
- If replies are placeholders, verify `LLAMA_BIN` and `LLAMA_MODEL`.
- If text replies work but no audio plays, verify `TTS_PROVIDER`, `CHATTERBOX_TTS_URL`, and that the TTS service is healthy on port `5010`.
- If the `Open Model Web UI` button is not relevant to your local setup, ignore it. It is only useful if you separately run a model UI on `http://localhost:7860`.

Legacy paths
- `wsl-bot` and `win-bot` contain older Python-based experiments using FastAPI, `faster-whisper`, and Coqui TTS.
- Those paths are not the primary launcher integration described in this document.

