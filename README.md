# Mana

Mana is a local-first AI assistant for Windows. It listens from the desktop launcher, transcribes speech locally, replies with local GGUF models, speaks through local TTS services, and can read visible screen text after it is awake.

The project is built for a personal Windows setup: one user, local models by default, clear setup checks, and optional companion features when you want phone access or avatar control.

## Quick Start

The current supported path is the Windows launcher plus the local Node backend.

```powershell
cd C:\ManaAI\Mana\node-bot
npm install

cd C:\ManaAI\Mana\windows-launcher
npm install
npm run start
```

For the full setup flow, including model paths, Whisper, TTS services, gaming mode, and optional market helpers, see [docs/quick_start_windows.md](docs/quick_start_windows.md).

## Highlights

- **Local AI by default**: Mana uses local `llama.cpp` models unless remote AI is explicitly enabled.
- **Voice loop**: wake Mana once with `Mana` or `wake up`, then keep talking without repeating the wake word.
- **Local transcription**: audio is transcribed through `whisper.cpp`.
- **Local text generation**: replies come from GGUF models through `llama.cpp`.
- **Local speech output**: Kokoro, Chatterbox, and Fish Speech provider paths are supported.
- **Screen text awareness**: after Mana is awake, the launcher can capture the primary display and OCR readable text locally.
- **Gaming mode**: Mana reduces idle work while watched games are running.
- **Desktop avatar support**: PNG overlay and optional VTube Studio hotkey control.
- **Mobile companion path**: phone chat and summary sync are available through the local backend and optional tunnel setup.
- **FFXIV and market helpers**: Mana can query Universalis crafting/market data and Alpha Vantage stock summaries when configured.

## Architecture

Mana is intentionally split into small runtime pieces:

- `windows-launcher`: Electron desktop launcher, microphone capture, avatar overlay control, screen capture, performance panel, and Doctor panel.
- `node-bot`: local backend API for transcription, replies, TTS calls, screen OCR, mobile routes, market helpers, and setup checks.
- `tts-service`: local Python services for Chatterbox and Kokoro TTS.
- `tools/whisper`: expected location for local `whisper.cpp` binaries and models.
- `tools/llama`: expected location for local `llama.cpp` binaries and GGUF models.
- `windows-native-launcher`: planned lower-memory native Windows launcher.
- `wsl-bot` and `win-bot`: older experimental paths, not the primary launcher flow.

## Local AI And Privacy

Mana is designed to run on your machine instead of depending on a hosted assistant stack.

Default behavior:

- `OPENAI_API_KEY` is ignored unless `MANA_ALLOW_REMOTE_AI=1`.
- Local replies use the configured `LLAMA_BIN` and `LLAMA_MODEL`.
- Audio transcription uses local Whisper binaries.
- Screen awareness uses local OCR through `tesseract.js`.
- Chat summaries and mobile memory are stored locally unless you intentionally sync or expose them.

Remote AI is an explicit escape hatch, not the default path.

## Model Stack

The intended local model stack is:

- **Primary chat**: `Qwen3-4B-Q4_K_M.gguf`
- **Fast fallback**: `qwen2.5-1.5b-instruct-q4_k_m.gguf`
- **Quality mode**: `Qwen3-8B-Q4_K_M.gguf`
- **Coding mode**: `qwen2.5-coder-7b-instruct-q4_k_m.gguf`

If `LLAMA_MODEL` is unset, Mana searches local model folders and chooses the default profile in order: 4B, 1.5B, then 8B.

## Doctor And Troubleshooting

Mana includes setup checks for the local runtime.

From the backend:

```powershell
cd node-bot
npm run doctor
```

From the Windows launcher, use the **Doctor** panel and **Run checks** button.

Doctor checks currently cover:

- Node runtime
- local AI policy
- llama binary and model paths
- Whisper configuration
- local TTS health URLs
- mobile auth configuration
- local storage writability
- backend port availability

Common troubleshooting:

- If the launcher reports `Local backend not reachable`, check port `5005` and run `npm run doctor`.
- If replies are placeholders, verify `LLAMA_BIN` and `LLAMA_MODEL`.
- If transcription fails, verify `WHISPER_BIN` and `WHISPER_MODEL`.
- If text replies work but no audio plays, check `TTS_PROVIDER` and the configured local TTS service.

## Docs By Goal

- [Windows quick start](docs/quick_start_windows.md): full setup and daily run flow.
- [Mobile PWA and Cloudflare Tunnel](docs/mobile_pwa_cloudflare.md): phone companion setup.
- [PNG avatar setup](docs/png_avatar_setup.md): desktop avatar overlay.
- [VTube Studio setup](docs/vtube_studio_setup.md): avatar hotkeys and reactions.
- [Native launcher plan](docs/native_launcher_plan.md): lower-memory launcher direction.
- [Chatterbox voice tuning](docs/chatterbox_voice_tuning.md): Chatterbox voice settings.
- [Fish Speech TTS](docs/fish_speech_tts.md): optional Fish Speech provider.
- [Market analysis helper](docs/market_analysis_helper.md): stock-market helper setup.

## Backend API

The main backend listens on `http://localhost:5005` by default.

Useful endpoints:

- `GET /health`: basic backend status.
- `GET /doctor`: setup and readiness checks.
- `GET /perf/status`: local performance and process metrics.
- `POST /transcribe`: audio upload, transcription, and reply.
- `POST /transcribe-only`: audio upload and transcription only.
- `POST /reply`: text reply from Mana.
- `POST /synthesize`: TTS audio for text.
- `POST /screen/read`: local OCR for a screen image.
- `GET /ffxiv/market`: Universalis market lookup.
- `GET /ffxiv/crafting/profit`: craft-profit scan.
- `GET /market/stock/summary`: stock summary.
- `GET /market/stock/compare`: stock comparison.
- `GET /market/watchlist`: configured watchlist summary.

See [node-bot/README.md](node-bot/README.md) for backend-specific details.

## Development

Install dependencies in the packages you are changing:

```powershell
cd node-bot
npm install

cd ..\windows-launcher
npm install
```

Run the backend tests:

```powershell
cd node-bot
npm test
```

Run the launcher tests:

```powershell
cd windows-launcher
npm test
```

Use `npm run dev` in `windows-launcher` when editing the launcher/backend loop and you want auto-restart behavior.

## Required Before Pushing

Before pushing any branch, run status and verification checks for the files you changed.

Minimum required check:

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

## Status

Mana is under active development. The current stable path is:

```text
windows-launcher -> node-bot -> local Whisper / local Llama / local TTS
```

The next major engineering priorities are backend modularization, richer component health status, explicit local model management, and stronger mobile device controls.
