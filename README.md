# Mana

Mana is a local AI assistant for Windows.

The current project goal is a simple local voice loop:
- launch the Windows app
- show the PNG avatar overlay in the bottom-left corner
- say `Mana` once to wake her up
- keep talking without repeating the wake word
- transcribe the audio locally with `whisper.cpp`
- generate a local reply with `llama.cpp`
- speak the reply back through a local TTS service

## Current architecture

The supported path in this repository is:
- `windows-launcher` for the Electron desktop app
- `node-bot` for the local backend API
- `tools/whisper` for the `whisper.cpp` runtime
- `tools/llama` for the `llama.cpp` runtime
- `tts-service` for the local Chatterbox Turbo TTS microservice
- VTube Studio Public API support for avatar hotkeys and reactions

## What Mana does

Mana is meant to run on your own machine instead of depending on a hosted assistant stack.

Right now the main focus is:
- continuous local voice input
- one-time wake-word response after you say `Mana`
- ignores blank audio and common non-speech noise
- startup PNG avatar overlay
- local speech-to-text
- local text generation
- local text-to-speech playback
- optional VTube Studio avatar control
- optional PNG avatar overlay
- a Windows launcher that ties the pieces together

## Repository notes

- `wsl-bot` and `win-bot` are older experimental paths and are not the main launcher flow.
- The active Windows path is `windows-launcher` + `node-bot`.
- If you do not set a local GGUF model manually, the backend can fall back to a small Hugging Face GGUF target through `llama.cpp`.

See `docs/quick_start_windows.md` for the current setup flow.

See `docs/vtube_studio_setup.md` for avatar setup.

See `docs/png_avatar_setup.md` for the simple bottom-left PNG avatar overlay.
