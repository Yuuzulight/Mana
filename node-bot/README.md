Node-bot (whisper.cpp + llama.cpp)

Overview
--------
This Node.js backend accepts audio uploads, uses local whisper.cpp to transcribe, runs local llama.cpp (GGUF) to generate replies, and can synthesize reply audio by calling a local Chatterbox Turbo TTS microservice.

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
  - Download a GGUF model (7B community gguf) and set LLAMA_MODEL env var to it.
- Chatterbox Turbo TTS service
  - Set `TTS_PROVIDER=chatterbox`.
  - Run the Python service in `../tts-service`.
  - Set `CHATTERBOX_TTS_URL` if you move the service off the default port.
- ffmpeg on PATH (optional, used to convert webm recordings to WAV)

Install and run
---------------
1. Install Node dependencies
   cd node-bot
   npm install

2. Set environment variables (example PowerShell):
   $env:WHISPER_BIN = "C:\\tools\\whisper.cpp\\main.exe"
   $env:WHISPER_MODEL = "C:\\models\\ggml-base.en.bin"
   $env:LLAMA_BIN = "C:\\tools\\llama.cpp\\main.exe"
   $env:LLAMA_MODEL = "C:\\models\\7b.gguf"
   $env:TTS_PROVIDER = "chatterbox"
   $env:CHATTERBOX_TTS_URL = "http://127.0.0.1:5010"

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
- CLI flags for whisper.cpp and llama.cpp vary between forks/builds. If the binaries you use require different flags, edit node-bot/server.js accordingly.
- `node-bot` can still support a generic CLI TTS path, but the intended realistic-voice path is the Chatterbox microservice.
- This server does synchronous subprocess calls for simplicity. For production or heavy usage, consider using streaming or persistent server processes for llama.cpp (server mode) to reduce startup overhead.
