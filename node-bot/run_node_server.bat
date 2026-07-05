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
set "LLAMA_MODEL=C:\ManaAI\Mana\tools\llama\gguf-models\Qwen3-4B-Q4_K_M.gguf"
REM Coding mode: C:\ManaAI\Mana\tools\llama\gguf-models\qwen2.5-coder-7b-instruct-q4_k_m.gguf
REM Fast fallback: C:\ManaAI\Mana\tools\llama\gguf-models\qwen2.5-1.5b-instruct-q4_k_m.gguf
REM Quality backup: C:\ManaAI\Mana\tools\llama\gguf-models\Qwen3-8B-Q4_K_M.gguf

cd /d "%~dp0"

REM Launch start_mana.ps1 to run retriever + node with .env loaded
powershell -ExecutionPolicy Bypass -File "%~dp0start_mana.ps1" %*
exit /b 0

REM If a project venv exists, set PYTHON_BIN to use it automatically
set "PROJECT_VENV_PY=%~dp0..\ManaAIManatext-generation-webui\venv\Scripts\python.exe"
if exist "%PROJECT_VENV_PY%" (
  echo Using project venv python at %PROJECT_VENV_PY%
  set "PYTHON_BIN=%PROJECT_VENV_PY%"
)

REM Start retriever service in background (if Python is available)
set "RETRIEVER_SCRIPT=%~dp0..\tools\retriever_service.py"
if exist "%RETRIEVER_SCRIPT%" (
  echo Starting retriever service...
  REM Use PYTHON_BIN if set, otherwise rely on PATH
  if defined PYTHON_BIN (
    start "Mana Retriever" /B "%PYTHON_BIN%" -u "%RETRIEVER_SCRIPT%"
  ) else (
    start "Mana Retriever" /B python -u "%RETRIEVER_SCRIPT%"
  )
) else (
  echo Retriever service not found at %RETRIEVER_SCRIPT%
)

REM Start the Node backend (main)

REM If RUN_SMOKE_TEST=1, start Node in background so we can run the smoke test and unit tests; otherwise run Node in foreground
if "%RUN_SMOKE_TEST%"=="1" (
  echo Starting Node in background (smoke test + unit test mode)...
  start "Mana Node" /B node server.js
  REM give Node a moment to initialize
  timeout /t 5 /nobreak >nul

  echo Running smoke test (tools/smoke_test.js)...
  node "%~dp0..\tools\smoke_test.js"
  set "SMOKE_ERR=%ERRORLEVEL%"

  echo Running unit tests (node --test test/*.test.js)...
  npm test
  set "UNIT_ERR=%ERRORLEVEL%"

  if "%SMOKE_ERR%"=="0" (
    echo Smoke test passed
  ) else (
    echo Smoke test failed (exit %SMOKE_ERR%)
  )

  if "%UNIT_ERR%"=="0" (
    echo Unit tests passed
  ) else (
    echo Unit tests failed (exit %UNIT_ERR%)
  )

  REM Exit non-zero if either test failed
  if NOT "%SMOKE_ERR%"=="0" (
    exit /b %SMOKE_ERR%
  )
  if NOT "%UNIT_ERR%"=="0" (
    exit /b %UNIT_ERR%
  )

  echo All checks passed, leaving Node running in background.
  exit /b 0
) else (
  node server.js
)
