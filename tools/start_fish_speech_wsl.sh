#!/usr/bin/env bash
set -euo pipefail

cd /mnt/c/ManaAI/Mana/tools/fish-speech

if [ ! -x .venv/bin/python ]; then
  echo "Fish Speech .venv is missing. Run: /home/user/.local/bin/uv venv --python 3.12 .venv"
  exit 1
fi

source .venv/bin/activate

# Quick rundown: Mana expects Fish Speech on http://127.0.0.1:8080.
# Install dependencies first with: /home/user/.local/bin/uv sync --extra cu128
python tools/api_server.py --listen 0.0.0.0:8080
