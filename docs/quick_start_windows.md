Quick start (Windows, current path)

This document describes the supported setup as of June 18, 2026.

Architecture
- `windows-launcher` runs the Electron UI.
- The Electron main process starts `node-bot/server.js`.
- `node-bot` calls local `whisper.cpp` and `llama.cpp` binaries.
- `node-bot` uses local OCR for screen text when Mana is awake.
- `node-bot` can call local Kokoro ONNX, Chatterbox Turbo, or Fish Speech TTS services to synthesize reply audio.
- The renderer records short audio chunks in the browser, converts them to WAV, and uses the local backend for transcription and replies.

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
     - `$env:KOKORO_TTS_URL = "http://127.0.0.1:5011"`
     - `$env:CHATTERBOX_TTS_URL = "http://127.0.0.1:5010"`
     - `$env:FISH_TTS_URL = "http://127.0.0.1:8080"`
     - `$env:CHATTERBOX_MODEL = "turbo"`
     - `$env:CHATTERBOX_VOICE_REF = "C:\path\to\evil-style-reference.wav"`
     - `$env:CHATTERBOX_EXAGGERATION = "0.35"`
     - `$env:CHATTERBOX_CFG_WEIGHT = "0.45"`
     - `$env:CHATTERBOX_TEMPERATURE = "0.8"`
     - `$env:SCREEN_CONTEXT_ENABLED = "1"`
     - `$env:SCREEN_CONTEXT_MAX_CHARS = "1200"`
     - `$env:WHISPER_THREADS = "2"`
     - `$env:LLAMA_THREADS = "4"`
     - `$env:LLAMA_MAX_TOKENS = "180"`

   Notes:
   - `WHISPER_BIN` should point to the Whisper CLI executable you want to use.
   - If `WHISPER_BIN` is unset or wrong, Mana will also try common local paths under `tools\whisper\`.
   - `LLAMA_BIN` should point to the Llama CLI executable you want to use.
   - `TTS_PROVIDER=kokoro` tells Mana to use the faster Kokoro ONNX service.
   - `TTS_PROVIDER=chatterbox` tells Mana to use the local Chatterbox TTS microservice.
   - `TTS_PROVIDER=fish` tells Mana to call a separately running Fish Speech server.
   - `FISH_TTS_FALLBACK_PROVIDER=kokoro` keeps Mana speaking through Kokoro if Fish Speech is unavailable.
   - `CHATTERBOX_VOICE_REF` should point to a short reference clip that matches the direction you want.
   - Lower `CHATTERBOX_CFG_WEIGHT` and a moderate `CHATTERBOX_EXAGGERATION` help push the voice toward a sharper, more stylized agent delivery.
   - If `LLAMA_BIN` or `LLAMA_MODEL` is not set, the backend returns a placeholder reply so you can still test audio capture and transcription.
   - If the Chatterbox service is not running, the UI still shows the text reply but will not play synthesized audio.
   - `SCREEN_CONTEXT_ENABLED=0` disables screen reading if you want the lightest runtime path.
   - `WHISPER_THREADS`, `LLAMA_THREADS`, and `LLAMA_MAX_TOKENS` cap heavy local work so games keep more CPU.

3) Install launcher and backend dependencies
   - In PowerShell:
     - `cd C:\ManaAI\Mana\node-bot`
     - `npm install`
     - `cd C:\ManaAI\Mana\windows-launcher`
     - `npm install`

4) Install the local TTS services
   - In PowerShell:
     - `cd C:\ManaAI\Mana\tts-service`
     - `.\start.ps1`
     - `.\start_kokoro.ps1`

   On first run this installs the Python dependencies and downloads the models.

5) Start the launcher
   - In PowerShell:
     - `cd C:\ManaAI\Mana\windows-launcher`
     - `npm run start`

   The launcher starts `node-bot` automatically and will also try to start Kokoro as primary TTS and Chatterbox as fallback.

   Development auto-restart:
   - Use `npm run dev` instead of `npm run start` while editing Mana.
   - The Electron app restarts when launcher or backend source files change.

6) Use Mana
   - Start the Windows launcher.
   - Mana shows the PNG avatar overlay and starts listening automatically.
   - Keep `Gaming mode` checked when you want Mana to run lighter while a watched game is open.
   - Say `Mana` once to wake her for the session.
   - After that first wake-up, keep talking without repeating the wake word.
   - After Mana is awake, she reads visible screen text before replying.
   - The UI shows the transcript and model reply.
   - If Chatterbox is running, the reply is synthesized and played back by the app.

Screen reading notes
- Screen reading is local OCR through `tesseract.js`.
- It helps Mana read menus, chat, UI labels, and other visible text.
- It does not yet understand images, icons, characters, or game scenes without readable text.
- The launcher downscales screen captures before OCR so it is lighter while a game is running.

Performance notes
- `Gaming mode` checks Windows for watched game processes such as FFXIV.
- When a watched game is running, Mana waits longer after empty/noise chunks to reduce idle work.
- When a watched game is running, Mana records longer chunks, calls Whisper less often, and reuses screen OCR longer.
- While gaming, Mana only refreshes screen OCR for commands that look screen-related, such as asking her to read, look, or explain an icon/menu.
- Set `GAMING_PROCESS_NAMES` to a comma-separated process list if you want to watch other games.
- Example: `$env:GAMING_PROCESS_NAMES = "ffxiv_dx11.exe,eldenring.exe"`

Troubleshooting
- If the UI reports `Local backend not reachable`, check that `node-bot` started successfully and that nothing else is using port `5005`.
- If transcription fails immediately, verify `WHISPER_BIN` and `WHISPER_MODEL`.
- If replies are placeholders, verify `LLAMA_BIN` and `LLAMA_MODEL`.
- If text replies work but no audio plays, verify `TTS_PROVIDER`, `CHATTERBOX_TTS_URL`, and that the TTS service is healthy on port `5010`.
- If the `Open Model Web UI` button is not relevant to your local setup, ignore it. It is only useful if you separately run a model UI on `http://localhost:7860`.

Legacy paths
- `wsl-bot` and `win-bot` contain older Python-based experiments using FastAPI, `faster-whisper`, and Coqui TTS.
- Those paths are not the primary launcher integration described in this document.

