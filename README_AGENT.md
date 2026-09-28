# README_AGENT.md

Setup guide for coding agents (Claude Code, Codex, ...) installing and running
Mana on Windows for a user (#708). Humans: start with
[docs/quick_start_windows.md](docs/quick_start_windows.md) and
[docs/native_launcher_plan.md](docs/native_launcher_plan.md).

All paths are relative to the repo root. Never commit `.env` or model files.

## 1. Prerequisites

- Windows 11 x64 (the native launcher targets Windows 10 19041+). An NVIDIA GPU is expected (the bundled llama.cpp builds are CUDA).
- Node.js: CI runs 18.18.0 and 22 (`.github/workflows/fast-node-tests.yml`, `heavy-ci.yml`).
- .NET 8 SDK, not just the runtime (native launcher).
- Python 3.10+ for Kokoro and the embedder; Python 3.12 for Fish Speech.
- Git (Fish Speech lives in the `tools/fish-speech` submodule).

## 2. Backend dependencies

```powershell
cd node-bot
npm install        # CI uses `npm ci`
```

## 3. Binaries and models (all under `tools/`, which is gitignored)

| What | Where Mana looks | Override |
|---|---|---|
| llama.cpp build | a `llama-bNNNNN-bin-win-cuda-12.4-x64` folder (plus its cudart DLLs) under `tools/llama/` | `LLAMA_BIN` (folder's `llama-cli.exe`; `llama-server.exe` is taken from the same folder) or `LLAMA_SERVER_BIN` |
| Chat models (.gguf) | searched by filename per profile under `tools/llama/` (e.g. `tools/llama/gguf-models/Qwen3-4B-Q4_K_M.gguf`; names in `LLAMA_MODEL_PROFILES`, `node-bot/ai/local-ai.js`) | `LLAMA_MODEL` (default profile only) |
| whisper.cpp | `tools/whisper/Release/whisper-cli.exe` | `WHISPER_BIN` |
| Whisper model | any `ggml-*.bin` under `tools/whisper/`; the native launcher passes `tools/whisper/models/ggml-tiny.en.bin` | `WHISPER_MODEL` |

`llama-server.exe` is resolved in this order (`findLlamaServerBin`,
`node-bot/ai/llama-server-runtime.js`): `tools/llama/active.json` (written by
the atomic build updater, #696: `POST /models/llama-build/check`, `/update`,
`/rollback`), then `LLAMA_SERVER_BIN`, then next to `LLAMA_BIN`, then
`tools/llama/llama-b9436-bin-win-cuda-12.4-x64/`, then `tools/llama/`.

Vision models: [docs/vision_setup.md](docs/vision_setup.md).

## 4. Python services

**Kokoro TTS (required by the native launcher: it refuses to start if
`tts-service/venv` is missing).** `start_kokoro.ps1` expects the venv to exist,
then installs `requirements.txt`, downloads the ONNX model/voices into
`tts-service/kokoro/` and serves on port 5011 in the foreground (the launcher reuses it while it runs,
or starts it itself later):

```powershell
python -m venv tts-service\venv
cd tts-service
.\start_kokoro.ps1
```

**Fish Speech S1-mini (default `TTS_PROVIDER=fish`, optional: Mana falls back
to Kokoro without it).** Follow [docs/fish_speech_tts.md](docs/fish_speech_tts.md)
(venv at `tools/fish-speech/.venv-native`, checkpoint in
`tools/fish-speech/checkpoints/openaudio-s1-mini`, port 8080). Launch
failures are logged to `tools/fish-speech/launcher.log`.

**Local embedder (optional; memory search stays keyword-only without it).**
The launcher runs `node-bot/tools/local_embedder.py` on port 9001 with
`venv/` at the repo root if present, else `python` on PATH:

```powershell
python -m venv venv
venv\Scripts\python -m pip install fastapi uvicorn sentence-transformers
```

## 5. Configuration

```powershell
Copy-Item node-bot\.env.sample node-bot\.env
```

Edit `node-bot/.env`: replace the example `C:\ManaAI\Mana\...` paths with
this checkout's paths (or delete those lines and rely on the defaults in
section 3). The `MOBILE_*` lines are only for the phone companion; delete
them if unused.

**Nothing loads `.env` automatically**: `node-bot/server.js` and both
launchers read only the process environment. Load it into the shell you
start Mana from (children inherit it):

```powershell
Get-Content node-bot\.env | Where-Object { $_ -match '^\s*[A-Za-z_][A-Za-z0-9_]*=' } |
  ForEach-Object { $k, $v = $_ -split '=', 2; Set-Item "env:$($k.Trim())" $v.Trim() }
```

Recently changed variables (all optional):

| Variable | Default | Notes |
|---|---|---|
| `MANA_BIND_HOST` | loopback only | Set `0.0.0.0`/LAN IP only if another device must connect; exposes reply + tools (#719, #670). |
| `MANA_ALLOWED_HOSTS` | `localhost` + IP literals | Extra hostnames allowed in `Host` (tunnels, DNS names). Comma-separated (#722). |
| `MANA_ALLOWED_ORIGINS` | Mana's own pages, `file://`, extensions | Extra browser origins allowed to POST/WebSocket. Comma-separated (#722). |
| `MANA_TOOL_CALLING_ENABLED` | on | `0` disables tool calling (#672). |
| `USE_EMBEDDINGS` | on when started by a launcher | `0` keeps the embedder unused; plain `node server.js` needs `1` (#711). |
| `MANA_START_EMBEDDER` | on | `0` stops the launchers from starting the embedder (#711). |
| `MANA_RERANKER_MODEL` | off | Path to a local reranker .gguf; runs a CPU-only second llama-server (#721). |
| `MANA_RELATED_FACTS_MAX_CHARS` | 300 | Size cap for related memory facts in the prompt. |
| `MANA_LLAMA_REASONING` | `off` | `on`/`auto` enables `--reasoning`; Qwen3-style models may then return empty replies. |
| `PORT` | 5005 | Backend port. |

## 6. Run

Native launcher (primary; starts Kokoro, Fish Speech if set up, the embedder
and node-bot unless each already answers its health URL):

```powershell
cd windows-native-launcher
dotnet build
dotnet run
```

Backend only (e.g. headless checks):

```powershell
cd node-bot
npm start          # node server.js
```

`windows-launcher` (Electron) is a legacy fallback only.

## 7. Verify

```powershell
cd node-bot
npm test                              # node run_tests.js; SKIP_HEAVY_MODEL_TESTS=1 skips heavy tests, as fast CI does
npm run doctor                        # node doctor.js: setup + hardware checks and model recommendation
Invoke-RestMethod http://127.0.0.1:5005/health    # with the backend running

cd ..\windows-native-launcher\ManaNativeLauncher.Tests
dotnet test
```

In the native launcher, the tray menu's **Doctor** item shows the same checks.

## 8. Common failures

| Symptom | Fix |
|---|---|
| Launcher: "Kokoro Python environment was not found" | Create `tts-service\venv` and run `start_kokoro.ps1` once (section 4). |
| "llama-server executable not found. Checked: ..." | Put a llama.cpp build under `tools/llama/` or set `LLAMA_SERVER_BIN`/`LLAMA_BIN`. |
| "llama-server: refusing to load ... needs ~N MB free VRAM" | Free VRAM or pick a smaller model; `LLAMA_SERVER_VRAM_GUARD=0` overrides. |
| `Host "..." is not allowed` / `Origin "..." is not allowed` | Add it to `MANA_ALLOWED_HOSTS` / `MANA_ALLOWED_ORIGINS`. |
| Another device can't reach port 5005 | Loopback-only by default; set `MANA_BIND_HOST` (read the warning in `.env.sample` first). |
| Env vars seem ignored | `.env` isn't auto-loaded; load it into the shell (section 5) and restart. |
| Text replies but no audio | Check Kokoro (`http://127.0.0.1:5011/health`) and Fish Speech (`http://127.0.0.1:8080/v1/health`), `TTS_PROVIDER`. |
| Transcription fails immediately | Check `WHISPER_BIN` / `WHISPER_MODEL`. |
| Empty replies from a reasoning model | Leave `MANA_LLAMA_REASONING` unset (`off`). |
