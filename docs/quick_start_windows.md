Quick start (Windows, current path)

This document describes the supported setup as of June 18, 2026.

Architecture
- `windows-launcher` runs the Electron UI.
- The Electron main process starts `node-bot/server.js`.
- `node-bot` calls local `whisper.cpp` and `llama.cpp` binaries.
- `node-bot` can call local Kokoro ONNX, Fish Speech, or GPT-SoVITS TTS services to synthesize reply audio.
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
   - Python 3.10+ for the Kokoro TTS service
   - Local model files for Whisper and Llama

2) Configure backend environment variables
   - Open PowerShell and set:
     - `$env:WHISPER_BIN = "C:\path\to\whisper-cli.exe"`
     - `$env:WHISPER_MODEL = "C:\path\to\ggml-model.bin"`
     - `$env:WHISPER_LANGUAGE = "en"`
     - `$env:WHISPER_PROMPT = "Singapore English conversation with an AI assistant named Mana. Wake words include Mana, Manah, Manna, Mannah, Myna, My Na, and wake up."`
     - `$env:LLAMA_BIN = "C:\path\to\llama-cli.exe"`
     - `$env:LLAMA_MODEL = "C:\path\to\model.gguf"`
     - `$env:TTS_PROVIDER = "fish"`
     - `$env:KOKORO_TTS_URL = "http://127.0.0.1:5011"`
     - `$env:FISH_TTS_URL = "http://127.0.0.1:8080"`

   Notes:
   - `WHISPER_BIN` should point to the Whisper CLI executable you want to use.
   - If `WHISPER_BIN` is unset or wrong, Mana will also try common local paths under `tools\whisper\`.
   - `WHISPER_PROMPT` helps Whisper understand accents, wake words, and common local phrasing.
   - For Singaporean-accent recognition, `ggml-base.en.bin` or `ggml-small.en.bin` should be more accurate than `ggml-tiny.en.bin`.
   - `$env:WHISPER_MODEL_PROFILE = "small"` (`tiny`/`base`/`small`/`medium`) picks a size tier by name instead of a raw file path, if you keep more than one model under `tools\whisper\models`. Smaller is faster but less accurate; falls back to whatever's actually present if the requested tier's file isn't there.
   - `LLAMA_BIN` should point to the Llama CLI executable you want to use.
   - `TTS_PROVIDER=kokoro` tells Mana to use the faster Kokoro ONNX service.
   - `TTS_PROVIDER=fish` (the default) tells Mana to call a separately running Fish Speech server; see docs/fish_speech_tts.md.
   - `FISH_TTS_FALLBACK_PROVIDER=kokoro` keeps Mana speaking through Kokoro if Fish Speech is unavailable.
   - If `LLAMA_BIN` or `LLAMA_MODEL` is not set, the backend returns a placeholder reply so you can still test audio capture and transcription.
   - If the configured TTS service is not running, the UI still shows the text reply but will not play synthesized audio.

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

   The launcher starts `node-bot` automatically and will also try to start whichever launcher-managed TTS provider is configured (Kokoro or GPT-SoVITS; Fish Speech runs separately, see docs/fish_speech_tts.md).

6) Use Mana
   - Start the Windows launcher.
   - Mana shows the PNG avatar overlay and starts listening automatically.
   - Keep `Gaming mode` checked when you want Mana to run lighter while a watched game is open.
   - Say `Mana` once to wake her for the session.
   - After that first wake-up, keep talking without repeating the wake word.
   - Mana listens for your whole sentence and only treats it as your prompt
     once you've paused for about 2.2 seconds — a long sentence isn't cut
     off partway through. Tune the pause length with
     `MANA_SILENCE_BUFFER_MS` (milliseconds) if that feels too short or
     too long for how you talk.
   - The UI shows the transcript and model reply.
   - If the configured TTS service is running, the reply is synthesized and played back by the app.

Performance notes
- `Gaming mode` checks Windows for watched game processes such as FFXIV.
- When a watched game is running, Mana waits longer after empty/noise chunks to reduce idle work.
- Set `GAMING_PROCESS_NAMES` to a comma-separated process list if you want to watch other games.
- Example: `$env:GAMING_PROCESS_NAMES = "ffxiv_dx11.exe,eldenring.exe"`

Speech recognition debugging
- In the Electron dev console, run `localStorage.manaSpeechDebug = "1"` to log audio stats and skip reasons.
- Set `$env:SPEECH_DEBUG = "1"` before launching Mana to include backend Whisper debug metadata.
- With `manaSpeechDebug` on, transcription events (audio stats, skip/reject reasons, gain applied, wake-word matches, hallucination filtering) are also written to a per-session log file so you can review a "why didn't Mana hear me" report after the fact, not just live in devtools: `%APPDATA%\local-voice-bot-launcher\logs\speech-debug.log` (JSON lines, next to the existing `voice-crash.log`).
- Use short `.wav` samples for testing your voice. Mono 16-bit PCM at 16kHz or 48kHz is preferred.
- Mana recognizes a close mis-transcription of a wake word too (e.g. Whisper hearing "Manaa" or "Mona"), not just the exact spellings in the wake-word list -- no setting needed, this is always on.
- If quiet speech keeps getting skipped, or too much keyboard/mouse/fan noise gets through, tune these (defaults shown):
  - `$env:MANA_MIN_SPEECH_RMS = "0.012"` / `$env:MANA_MIN_SPEECH_PEAK = "0.04"` -- lower to stop skipping quiet real speech, raise to reject more background noise.
  - `$env:MANA_MAX_CLICKY_ZCR = "0.28"` -- lower to reject more clicky noise (keyboard/mouse), raise if real speech (especially sibilant sounds) is getting rejected as "clicky".
  - `$env:MANA_SPEECH_GAIN_TARGET_PEAK = "0.2"` / `$env:MANA_SPEECH_GAIN_MAX_BOOST = "6"` -- a quiet clip is boosted toward this target peak (capped at the max boost multiplier) before Whisper sees it, so soft-spoken speech both clears the thresholds above and transcribes more accurately. Set `MANA_SPEECH_GAIN_TARGET_PEAK = "0"` to disable.

Troubleshooting
- If the UI reports `Local backend not reachable`, check that `node-bot` started successfully and that nothing else is using port `5005`.
- If transcription fails immediately, verify `WHISPER_BIN` and `WHISPER_MODEL`.
- If replies are placeholders, verify `LLAMA_BIN` and `LLAMA_MODEL`.
- If text replies work but no audio plays, verify `TTS_PROVIDER` and that the configured TTS service is healthy (Kokoro on port `5011`, Fish Speech on port `8080`).
- If the `Open Model Web UI` button is not relevant to your local setup, ignore it. It is only useful if you separately run a model UI on `http://localhost:7860`.

Legacy paths
- `wsl-bot` and `win-bot` contain older Python-based experiments using FastAPI, `faster-whisper`, and Coqui TTS.
- Those paths are not the primary launcher integration described in this document.

