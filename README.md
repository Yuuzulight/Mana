# Mana

Mana is a local AI assistant for Windows.

The current project goal is a simple local voice loop:
- launch the Windows app
- show the PNG avatar overlay in the bottom-left corner
- say `Mana` or `wake up` once to wake her up
- keep talking without repeating the wake word
- transcribe the audio locally with `whisper.cpp`
- generate a local reply with `llama.cpp`
- speak the reply back through a local TTS service

## Current architecture

The supported path in this repository is:
- `windows-launcher` for the Electron desktop app
- `windows-native-launcher` for the planned lower-memory native Windows tray app
- `node-bot` for the local backend API
- `tools/whisper` for the `whisper.cpp` runtime
- `tools/llama` for the `llama.cpp` runtime
- `tts-service` for the local Chatterbox Turbo TTS microservice
- VTube Studio Public API support for avatar hotkeys and reactions

## What Mana does

Mana is meant to run on your own machine instead of depending on a hosted assistant stack.

Right now the main focus is:
- continuous local voice input
- one-time wake response after you say `Mana` or `wake up`
- ignores blank audio and common non-speech noise
- startup PNG avatar overlay
- local speech-to-text
- local text generation
- local text-to-speech playback
- local screen text reading after Mana is awake
- chunked reply speech so playback starts sooner
- gaming mode that detects watched game processes and reduces idle work while they run
- Kokoro ONNX fast TTS with Chatterbox and optional Fish Speech provider paths
- multilingual TTS routing for English, Chinese, Japanese, Korean, Russian, German, Spanish, and Malay
- single Mana voice across supported TTS languages
- optional VTube Studio avatar control
- optional PNG avatar overlay
- a Windows launcher that ties the pieces together

## Screen awareness

After Mana is awake, the launcher can capture the primary monitor, send the image to the local backend, and OCR visible text with `tesseract.js`.

This lets Mana answer using readable text on the screen. It does not yet give her full image/object understanding; that will need a local vision model later.

## Repository notes

- `wsl-bot` and `win-bot` are older experimental paths and are not the main launcher flow.
- The active Windows path is `windows-launcher` + `node-bot`.
- If you do not set a local GGUF model manually, the backend can fall back to a small Hugging Face GGUF target through `llama.cpp`.

## Required before pushing

Before pushing any branch, run status and verification checks for the files you changed.

Minimum required checks:

```powershell
git status --short --branch
```

If `node-bot` changed:

```powershell
cd node-bot
npm test
```

If `windows-launcher` changed:

```powershell
cd windows-launcher
npm test
```

For changed JavaScript files, also run `node --check` on each changed file that can be parsed by Node without a browser or Electron runtime.

Do not push if required checks fail. Fix the failure first, or clearly document the blocked check and why it could not be run before asking for review.

See `docs/quick_start_windows.md` for the current setup flow.

See `docs/vtube_studio_setup.md` for avatar setup.

See `docs/png_avatar_setup.md` for the simple bottom-left PNG avatar overlay.

See `docs/native_launcher_plan.md` for the lower-memory native launcher plan.
