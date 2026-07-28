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
# This build's own default checkpoint is checkpoints/s2-pro, which we don't
# have -- point it at the S1-mini weights instead:
# huggingface-cli download fishaudio/openaudio-s1-mini --local-dir checkpoints/openaudio-s1-mini
#
# --compile (issue #213): measured ~12x steady-state speedup (2.5 -> 31
# tokens/sec on an RTX 3070 Ti) at negligible extra VRAM cost. Trade-off:
# the first generation *request* after each (re)start pays a one-time
# ~4 minute compile trace (torch.compile is lazy -- it doesn't fire at
# process launch, only on the first real call), so expect the first reply
# after starting/restarting this service to be slow once, then fast.
# Requires a C compiler for Triton codegen -- if this errors with
# "Failed to find C compiler", run once:
#   sudo apt-get update && sudo apt-get install -y build-essential
python tools/api_server.py --listen 0.0.0.0:8080 \
  --llama-checkpoint-path checkpoints/openaudio-s1-mini \
  --decoder-checkpoint-path checkpoints/openaudio-s1-mini/codec.pth \
  --compile
