@echo off

set "WHISPER_BIN=C:\ManaAI\Mana\tools\whisper\Release\whisper-cli.exe"

set "WHISPER_MODEL=C:\ManaAI\Mana\tools\whisper\models\ggml-tiny.en.bin"

cd /d "%~dp0"

node server.js > node_server.log 2>&1
