@echo off

set "WHISPER_BIN=C:\ManaAI\Mana\tools\whisper\Release\whisper-cli.exe"
if not exist "%WHISPER_BIN%" set "WHISPER_BIN=C:\ManaAI\Mana\tools\whisper\whisper-cli.exe"
if not exist "%WHISPER_BIN%" set "WHISPER_BIN=C:\ManaAI\Mana\tools\whisper\main.exe"

set "WHISPER_MODEL=C:\ManaAI\Mana\tools\whisper\models\ggml-tiny.en.bin"

cd /d "%~dp0"

node server.js > node_server.log 2>&1
