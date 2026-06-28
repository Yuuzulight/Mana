Node-bot (whisper.cpp + llama.cpp)

Overview
--------
This Node.js backend accepts audio uploads, uses local whisper.cpp to transcribe, runs local llama.cpp (GGUF) to generate replies, and can synthesize reply audio by calling a local Chatterbox Turbo TTS microservice.

Mana's chat AI is local by default. `OPENAI_API_KEY` is ignored unless
`MANA_ALLOW_REMOTE_AI=1` is also set, so an accidentally present API key does
not cause paid/proxy AI usage.

Why this exists
---------------
You asked to avoid Python 3.14 compatibility issues, so this implementation uses native binaries (whisper.cpp and llama.cpp) and Node.js instead of Python packages like faster-whisper and Coqui TTS.

Current status
--------------
This is the primary backend used by `windows-launcher/main.js`.

Requirements
------------
- Node.js (LTS)
- npm
- whisper.cpp binary for Windows (main.exe) and a compatible whisper model (ggml)
  - Download/build whisper.cpp and place the executable somewhere, set WHISPER_BIN environment variable to it.
  - Download a whisper ggml model and set WHISPER_MODEL env var to the model path.
  - If `WHISPER_BIN` is unset or invalid, the backend also tries common local paths under `tools\whisper\`.
- llama.cpp main executable that supports GGUF models (Windows build)
  - Download/build llama.cpp and place main.exe somewhere, set LLAMA_BIN env var to it.
  - Mana is configured for `Qwen3-4B-Q4_K_M.gguf` as the main local model.
  - Keep `Qwen3-8B-Q4_K_M.gguf` as quality mode, `qwen2.5-coder-7b-instruct-q4_k_m.gguf` as coding mode, and `qwen2.5-1.5b-instruct-q4_k_m.gguf` as the fast fallback.
  - If `LLAMA_MODEL` is unset, Mana searches `tools\llama\` and picks the default profile in this order: 4B, 1.5B, then 8B.
  - `/reply` accepts optional `modelProfile` values: `default`, `quality`, or `coding`.
- Chatterbox Turbo TTS service
  - Set `TTS_PROVIDER=chatterbox`.
  - Run the Python service in `../tts-service`.
  - Set `CHATTERBOX_TTS_URL` if you move the service off the default port.
- ffmpeg on PATH (optional, used to convert webm recordings to WAV)
- Zed CLI on PATH or `ZED_BIN` set to `zed.exe` (optional, default editor for coding handoff)
- VS Code CLI on PATH or `VSCODE_BIN` set to `code.cmd` (optional alternate editor for coding handoff)

Install and run
---------------
1. Install Node dependencies
   cd node-bot
   npm install

2. Set environment variables (example PowerShell):
   $env:WHISPER_BIN = "C:\\tools\\whisper.cpp\\main.exe"
   $env:WHISPER_MODEL = "C:\\models\\ggml-base.en.bin"
   $env:LLAMA_BIN = "C:\\tools\\llama.cpp\\main.exe"
   $env:LLAMA_MODEL = "C:\\ManaAI\\Mana\\tools\\llama\\gguf-models\\Qwen3-4B-Q4_K_M.gguf"
   $env:MANA_ALLOW_REMOTE_AI = "0"
   $env:TTS_PROVIDER = "chatterbox"
   $env:CHATTERBOX_TTS_URL = "http://127.0.0.1:5010"
   $env:MARKET_PROVIDER = "alphavantage"
   $env:ALPHA_VANTAGE_API_KEY = "your-api-key"
   $env:MARKET_WATCHLIST = "NVDA,AMD,AAPL,MSFT"
   $env:ZED_BIN = "C:\\Program Files\\Zed\\zed.exe"
   $env:VSCODE_BIN = "C:\\Users\\User\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd"
   $env:MANA_DEFAULT_EDITOR = "zed"

3. Start the server
   npm start

API
---
POST /transcribe (multipart/form-data, field 'file')
  -> returns { transcript: "...", reply: "...", ttsConfigured: true|false }

POST /synthesize (JSON, body `{ "text": "..." }`)
  -> returns WAV audio

GET /health
  -> { ok: true, ttsConfigured: true|false }

GET /zed/status
  -> reports whether the local Zed CLI is available

POST /zed/open (JSON, body `{ "path": "C:\\ManaAI\\Mana", "line": 12 }`)
  -> opens an existing file or folder in Zed

GET /editors/status
  -> reports local Zed and VS Code CLI availability

POST /editors/open (JSON, body `{ "editor": "vscode", "path": "C:\\ManaAI\\Mana", "line": 12 }`)
  -> opens an existing file or folder in Zed by default, or VS Code when requested

GET /editors/workspace
  -> returns the active local coding workspace path, or null when none is set

POST /editors/workspace (JSON, body `{ "path": "C:\\ManaAI\\Mana", "editor": "zed" }`)
  -> sets the active local coding workspace without reading or editing files

GET /editors/workspace/files
  -> lists files inside the active local workspace, skipping heavy folders like node_modules and .git

GET /editors/workspace/file?path=src/index.js
  -> reads one bounded text file inside the active workspace

GET /market/stock/summary?symbol=NVDA
  -> returns an Alpha Vantage quote and company summary for one ticker

GET /market/stock/compare?symbols=NVDA,AMD
  -> returns summaries for two or more tickers

GET /market/watchlist
  -> returns summaries for the configured MARKET_WATCHLIST symbols

GET /ffxiv/market?world=Adamantoise&itemName=Potion
  -> returns a Universalis market summary for one item

GET /ffxiv/crafting/profit?world=Adamantoise&limit=10&scanLimit=500
  -> compares Garland Tools recipe materials against Universalis prices and returns the most profitable crafts

GET /ffxiv/crafting/profit?world=Adamantoise&query=ingot&limit=10
  -> narrows the recipe scan by crafted result name

GET /ffxiv/crafting/profit?world=Adamantoise&recipeSource=xivapi
  -> forces XIVAPI recipe rows instead of the default Garland Tools item docs

Notes
-----
- AI replies use local llama unless `MANA_ALLOW_REMOTE_AI=1` and `OPENAI_API_KEY` are both set.
- Editor integration only opens existing paths through local CLIs. It does not silently apply edits.
- The active editor workspace is local process memory. It helps Mana know which project you mean, and file inspection only happens through explicit workspace file-list or file-read requests.
- The intended local model stack is 4B primary, 8B quality mode, Qwen2.5-Coder 7B coding mode, and 1.5B fast fallback.
- CLI flags for whisper.cpp and llama.cpp vary between forks/builds. If the binaries you use require different flags, edit node-bot/server.js accordingly.
- `node-bot` can still support a generic CLI TTS path, but the intended realistic-voice path is the Chatterbox microservice.
- Stock-market features are analysis helpers only. Mana does not place trades, connect to brokerages, or provide financial advice.
- This server does synchronous subprocess calls for simplicity. For production or heavy usage, consider using streaming or persistent server processes for llama.cpp (server mode) to reduce startup overhead.
