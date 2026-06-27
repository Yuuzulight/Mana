@echo off
REM run_node_server.bat
REM Starts the node-bot server.
REM Edit the env vars below to set your local model settings.

REM --- AI replies ---
REM Mana uses local llama by default. Do not set OPENAI_API_KEY here.
set "MANA_ALLOW_REMOTE_AI=0"

REM --- Whisper (local STT, keep as-is) ---
set "WHISPER_BIN=C:\ManaAI\Mana\tools\whisper\Release\whisper-cli.exe"
set "WHISPER_MODEL=C:\ManaAI\Mana\tools\whisper\models\ggml-tiny.en.bin"

REM --- Local llama ---
set "LLAMA_BIN=C:\ManaAI\Mana\tools\llama\llama-b9436-bin-win-cuda-12.4-x64\llama-cli.exe"
set "LLAMA_MODEL=C:\ManaAI\Mana\tools\llama\gguf-models\qwen2.5-1.5b-instruct-q4_k_m.gguf"

cd /d "%~dp0"
node server.js
