@echo off
REM run_node_server.bat
REM Starts the node-bot server.
REM Edit the env vars below to set your API key and model settings.
REM To swap between your key and co-intern's key: change OPENAI_API_KEY below.

REM --- OpenAI proxy ---
set "OPENAI_API_KEY=sk-PASTE_YOUR_KEY_HERE"
set "OPENAI_BASE_URL=https://new.aicode.us.com"
set "OPENAI_MODEL=codex-gpt-5.5"

REM --- Whisper (local STT, keep as-is) ---
set "WHISPER_BIN=C:\ManaAI\Mana\tools\whisper\Release\whisper-cli.exe"
set "WHISPER_MODEL=C:\ManaAI\Mana\tools\whisper\models\ggml-tiny.en.bin"

REM --- Optional: local llama fallback (comment out if not using) ---
REM set "LLAMA_BIN=C:\ManaAI\Mana\tools\llama\llama-b9436-bin-win-cuda-12.4-x64\llama.exe"
REM set "LLAMA_MODEL=C:\ManaAI\Mana\tools\llama\gguf-models\llama-2-7b-chat-q4_0.gguf"

cd /d "%~dp0"
node server.js
