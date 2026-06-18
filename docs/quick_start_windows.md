Quick start (Windows, current path)

This document describes the supported setup as of June 18, 2026.

Architecture
- `windows-launcher` runs the Electron UI.
- The Electron main process starts `node-bot/server.js`.
- `node-bot` calls local `whisper.cpp` and `llama.cpp` binaries.
- `node-bot` can also call your chosen local TTS tool to synthesize reply audio.
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
   - A local TTS tool you want to use for reply audio
   - Local model files for Whisper and Llama

2) Configure backend environment variables
   - Open PowerShell and set:
     - `$env:WHISPER_BIN = "C:\path\to\whisper-cli.exe"`
     - `$env:WHISPER_MODEL = "C:\path\to\ggml-model.bin"`
     - `$env:LLAMA_BIN = "C:\path\to\llama-cli.exe"`
     - `$env:LLAMA_MODEL = "C:\path\to\model.gguf"`
     - `$env:TTS_BIN = "C:\path\to\your-tts.exe"`
     - `$env:TTS_MODEL = "C:\path\to\your-tts-model.bin"`
     - `$env:TTS_ARGS_JSON = '["-m","{model}","-p","{text}","-o","{output}"]'`

   Notes:
   - `WHISPER_BIN` should point to the Whisper CLI executable you want to use.
   - If `WHISPER_BIN` is unset or wrong, Mana will also try common local paths under `tools\whisper\`.
   - `LLAMA_BIN` should point to the Llama CLI executable you want to use.
   - `TTS_BIN` should point to the text-to-speech tool you want Mana to use for reply audio.
   - `TTS_ARGS_JSON` is a JSON array of CLI args. Use placeholders like `{text}`, `{output}`, `{model}`, `{voice}`, and `{speaker}` to match your tool.
   - If `LLAMA_BIN` or `LLAMA_MODEL` is not set, the backend returns a placeholder reply so you can still test audio capture and transcription.
   - If `TTS_BIN` is not set, the UI still shows the text reply but will not play synthesized audio.

3) Install launcher and backend dependencies
   - In PowerShell:
     - `cd C:\ManaAI\Mana\node-bot`
     - `npm install`
     - `cd C:\ManaAI\Mana\windows-launcher`
     - `npm install`

4) Start the launcher
   - In PowerShell:
     - `cd C:\ManaAI\Mana\windows-launcher`
     - `npm run start`

   The launcher starts `node-bot` automatically and expects the backend health endpoint at `http://localhost:5005/health`.

5) Use Push-to-Talk
   - Hold the `Push to talk (hold)` button, speak, then release.
   - The UI shows the transcript and model reply.
   - If TTS is configured, the reply is synthesized and played back by the app.

Troubleshooting
- If the UI reports `Local backend not reachable`, check that `node-bot` started successfully and that nothing else is using port `5005`.
- If transcription fails immediately, verify `WHISPER_BIN` and `WHISPER_MODEL`.
- If replies are placeholders, verify `LLAMA_BIN` and `LLAMA_MODEL`.
- If text replies work but no audio plays, verify `TTS_BIN`, `TTS_MODEL`, and `TTS_ARGS_JSON`.
- If the `Open Model Web UI` button is not relevant to your local setup, ignore it. It is only useful if you separately run a model UI on `http://localhost:7860`.

Legacy paths
- `wsl-bot` and `win-bot` contain older Python-based experiments using FastAPI, `faster-whisper`, and Coqui TTS.
- Those paths are not the primary launcher integration described in this document.

