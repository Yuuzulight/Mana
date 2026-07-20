# Mana

**License (code): Apache License 2.0 — © 2026 ManaAI.** See LICENSE and NOTICE.

**Artwork (images/sprites/avatar models): All rights reserved.** The images in `sprites/` and any avatar model files are proprietary and may not be reused without permission; see LICENSE-ARTWORK.

**Live2D Cubism Core** is proprietary to Live2D Inc., is not part of this repository, and is fetched at setup time under Live2D's own terms; see THIRD_PARTY.md.

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
- **Local image understanding**: with a vision GGUF installed, Mana can look at screenshots and images and talk about them; see [docs/vision_setup.md](docs/vision_setup.md).
- **Look-at-my-screen hotkey**: press `Ctrl+Alt+M` (configurable via `MANA_VISION_HOTKEY`) to have Mana capture the screen, describe it, and speak the answer.
- **Gaming mode**: Mana reduces idle work while watched games are running.
- **Desktop avatar support**: Mana emotes through a built-in Live2D VTuber avatar with lip sync and emotion reactions ([docs/live2d_avatar_setup.md](docs/live2d_avatar_setup.md)), PNG overlay fallback, and optional VTube Studio hotkey control. A fully 3D model option is planned as a future alternative.
- **Mobile companion path**: phone chat and summary sync are available through the local backend and optional tunnel setup.
- **Editor coding handoff**: Mana can detect local Zed or VS Code CLIs and open projects or files for coding help without applying edits silently.
- **FFXIV, market, and job-search helpers**: Mana can query Universalis crafting/market data, Alpha Vantage stock summaries, and live Adzuna job postings when configured, plus a local job-application tracker with resume/cover-letter tailoring, as self-contained optional plugins that also inject context into chat replies; see [Plugins](plugins/README.md).
- **MCP server (opt-in)**: Mana can expose its FFXIV market and web-access tools over the Model Context Protocol for local MCP clients like Claude Desktop or Claude Code; see [docs/roadmap/issue-42-mcp-support.md](docs/roadmap/issue-42-mcp-support.md).
- **Deep Research**: a "Research" button next to the composer runs a bounded, multi-source search-and-read pass and replies with a cited report instead of a single search-and-answer; see [docs/roadmap/issue-47-deep-research.md](docs/roadmap/issue-47-deep-research.md).

## Architecture

Mana is intentionally split into small runtime pieces:

- `windows-launcher`: Electron desktop launcher, microphone capture, avatar overlay control, screen capture, performance panel, and Doctor panel.
- `desktop-client`: Electron chat client packaged with a real Windows installer (electron-builder/NSIS), including a built-in Live2D avatar — currently loaded with a temporary testing placeholder model, see `desktop-client/AVATAR_NOTICE.md`.
- `node-bot`: local backend API for transcription, replies, TTS calls, screen OCR, mobile routes, and setup checks.
- `plugins`: self-contained optional feature plugins (FFXIV market/crafting, real-world stock market data, a local job-application tracker, live Adzuna job search) that register their own routes, contribute chat-reply context, and are discoverable via `GET /plugins`; see [plugins/README.md](plugins/README.md).
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
- Web search runs through a local SearXNG instance (no third-party search API, no key); wiki lookups and page reads Mana is pointed at do reach the public internet, since that's inherent to what they do. See [docs/web_access_setup.md](docs/web_access_setup.md). Set `MANA_WEB_ACCESS_ENABLED=0` to turn all of it off.

Remote AI is an explicit escape hatch, not the default path.

## Editor Integration

Mana can hand coding work to a local editor CLI. On this setup, Zed is the default editor.

Setup:

```powershell
$env:ZED_BIN = "C:\Program Files\Zed\zed.exe"
$env:VSCODE_BIN = "C:\Users\User\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd"
$env:MANA_DEFAULT_EDITOR = "zed"
```

If `ZED_BIN` is unset, Mana checks for `zed` on `PATH`. If `VSCODE_BIN` is unset, Mana checks for `code` on `PATH`.

Current behavior:

- `GET /editors/status` reports Zed and VS Code CLI availability.
- `POST /editors/open` opens an existing file or folder in the requested editor.
- If no editor is requested, Mana uses `MANA_DEFAULT_EDITOR`, falling back to Zed.
- `GET /editors/workspace` reports the active local workspace path Mana last opened or was told to use.
- `POST /editors/workspace` sets the active local workspace path explicitly.
- `GET /editors/workspace/files` lists files in the active workspace with heavy folders skipped.
- `GET /editors/workspace/file?path=...` reads one bounded text file inside the active workspace.
- `POST /editors/workspace/proposals` creates an in-memory edit proposal for review without writing the file.
- `GET /editors/workspace/proposals` and `GET /editors/workspace/proposals/:id` review pending proposals.
- `GET /zed/status` and `POST /zed/open` remain available as Zed-specific compatibility routes.
- Optional `line` and `column` values are passed as `file:line:column`.
- Mana does not silently inspect or modify code through this integration. File lists and reads require explicit endpoint calls, and edit proposals stay in memory for review instead of being applied to disk.
- Coding replies still use the local coding model profile unless remote AI is explicitly enabled.
- Zed can also launch Mana as a local External Agent through `node-bot\mana-acp-agent.js --acp`; see [docs/zed_external_agent.md](docs/zed_external_agent.md).

## Model Stack

The intended local model stack is:

- **Primary chat**: `Qwen3-4B-Q4_K_M.gguf`
- **Fast fallback**: `qwen2.5-1.5b-instruct-q4_k_m.gguf`
- **Quality mode**: `Qwen3-14B-Q4_K_M.gguf` (falls back to `Qwen3-8B-Q4_K_M.gguf` if not downloaded)
- **Coding mode**: `qwen2.5-coder-7b-instruct-q4_k_m.gguf`
- **Vision (optional)**: a multimodal GGUF such as `Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf` plus its `mmproj` file; see [docs/vision_setup.md](docs/vision_setup.md)

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
- Zed and VS Code CLI availability
- Zed External Agent entry point, local-only policy, and local backend reachability

Common troubleshooting:

- If the launcher reports `Local backend not reachable`, check port `5005` and run `npm run doctor`.
- If replies are placeholders, verify `LLAMA_BIN` and `LLAMA_MODEL`.
- If transcription fails, verify `WHISPER_BIN` and `WHISPER_MODEL`.
- If text replies work but no audio plays, check `TTS_PROVIDER` and the configured local TTS service.

## Docs By Goal

- [Windows quick start](docs/quick_start_windows.md): full setup and daily run flow.
- [Mobile PWA and Cloudflare Tunnel](docs/mobile_pwa_cloudflare.md): phone companion setup.
- [PNG avatar setup](docs/png_avatar_setup.md): desktop avatar overlay.
- [Live2D avatar setup](docs/live2d_avatar_setup.md): built-in VTuber avatar with lip sync.
- [VTube Studio setup](docs/vtube_studio_setup.md): avatar hotkeys and reactions.
- [Native launcher plan](docs/native_launcher_plan.md): lower-memory launcher direction.
- [Chatterbox voice tuning](docs/chatterbox_voice_tuning.md): Chatterbox voice settings.
- [GPT-SoVITS setup](docs/gpt_sovits_setup.md): trial anime-style voice-cloning provider.
- [Fish Speech TTS](docs/fish_speech_tts.md): optional Fish Speech provider.
- [Market analysis helper](docs/market_analysis_helper.md): stock-market helper setup.
- [Vision setup](docs/vision_setup.md): local image understanding with a vision GGUF.
- [Web access setup](docs/web_access_setup.md): local search (SearXNG), wiki lookups, and page reading.
- [Zed External Agent setup](docs/zed_external_agent.md): local Zed `agent_servers` configuration.
- [MCP support roadmap](docs/roadmap/issue-42-mcp-support.md): running Mana as an MCP server (`npm run mcp`) and the plan for MCP client support.
- [Deep Research roadmap](docs/roadmap/issue-47-deep-research.md): multi-step, multi-source research with a cited report, bounded steps/time, and a "Research" button in windows-launcher.

## Backend API

The main backend listens on `http://localhost:5005` by default.

Useful endpoints:

- `GET /health`: basic backend status.
- `GET /doctor`: setup and readiness checks.
- `GET /perf/status`: local performance and process metrics.
- `GET /plugins`: discover loaded plugins grouped by category (see [plugins/README.md](plugins/README.md)).
- `GET /editors/status`: local editor CLI availability.
- `POST /editors/open`: open an existing file or folder in Zed or VS Code.
- `GET /editors/workspace`: active local coding workspace.
- `POST /editors/workspace`: set the active local coding workspace.
- `GET /editors/workspace/files`: list active workspace files.
- `GET /editors/workspace/file`: read one bounded file inside the active workspace.
- `GET /editors/workspace/proposals`: list pending edit proposals.
- `POST /editors/workspace/proposals`: create an in-memory edit proposal.
- `GET /editors/workspace/proposals/:id`: inspect one edit proposal and preview diff.
- `GET /zed/status`: Zed CLI availability.
- `POST /zed/open`: open an existing file or folder in Zed.
- `POST /transcribe`: audio upload, transcription, and reply.
- `POST /transcribe-only`: audio upload and transcription only.
- `POST /reply`: text reply from Mana; accepts an optional `image` for vision replies.
- `POST /vision/describe`: local vision-model reply about an image.
- `POST /synthesize`: TTS audio for text.
- `POST /screen/read`: local OCR for a screen image.
- `POST /web/search`: web search via local SearXNG.
- `POST /web/read`: read and summarize a specific page.
- `GET /wiki/:term`: Wikipedia summary lookup.
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
