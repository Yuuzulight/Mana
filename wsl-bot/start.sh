#!/usr/bin/env bash
set -euo pipefail

# start.sh - meant to run inside WSL (Ubuntu).
# Place this repo in your WSL home directory (e.g. /home/<user>/wsl-bot)
# Usage: ./start.sh

VENV_DIR="$HOME/wsl-bot/venv"
PY="python3"

echo "Starting WSL bot environment..."

if [ ! -d "$VENV_DIR" ]; then
  echo "Creating virtualenv in $VENV_DIR"
  $PY -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"

echo "Upgrading pip and installing requirements..."
python -m pip install --upgrade pip
pip install -r "$HOME/wsl-bot/requirements.txt"

# Start text-generation-webui if present
WEBUI_DIR="$HOME/wsl-bot/text-generation-webui"
if [ -d "$WEBUI_DIR" ]; then
  echo "Found text-generation-webui at $WEBUI_DIR. Starting it in background..."
  # The exact launch command for text-generation-webui can vary by version.
  # Common commands: `python server.py --model <model>` or `python webui.py`.
  # Edit the line below if your webui launch command is different.
  (cd "$WEBUI_DIR" && nohup python server.py --listen --port 7860 > webui.log 2>&1 &)
  sleep 3
else
  echo "text-generation-webui not found in $WEBUI_DIR"
  echo "Please clone https://github.com/oobabooga/text-generation-webui into $WEBUI_DIR"
  echo "and place your GGUF model under $WEBUI_DIR/models/. Then re-run this script."
fi

# Start the voice bridge (FastAPI)
echo "Starting voice_bridge (FastAPI) on port 5005"
# Run uvicorn in background so the script exits and Electron can continue
nohup uvicorn voice_bridge:app --host 0.0.0.0 --port 5005 > voice_bridge.log 2>&1 &

sleep 1

# Print status
echo "Services started. Web UI (if available) should be at http://localhost:7860"
echo "Voice bridge available at http://localhost:5005 (endpoints: /transcribe, /synthesize)"

echo "Logs:"
echo " - $WEBUI_DIR/webui.log (if webui exists)"
echo " - $HOME/wsl-bot/voice_bridge.log"

# Keep the script quick; background services run independently.
exit 0
