"""Native-Windows launcher for tools/fish-speech's tools/api_server.py --
applies the two fixes needed to get torch.compile working outside WSL:

1. triton-windows must be installed in the fish-speech venv, pinned to the
   release that matches its exact torch build (a newer triton-windows has a
   different internal API and breaks silently).
2. torch._inductor's static CUDA launcher passes a 64-bit GPU pointer into a
   Windows 32-bit `long` and overflows. Disabling it falls back to the
   normal (still fully compiled) kernel launcher.

See docs/fish_speech_tts.md for how these were found and full setup steps.
Keeps tools/fish-speech/tools/api_server.py itself untouched (it's vendored
third-party code in a git submodule) -- this just patches the process before
handing off to it. Must be run with its working directory set to
tools/fish-speech (start_fish_speech_native.ps1 does this), since
api_server.py resolves its checkpoint paths relative to cwd.
"""

import os
import sys

# `runpy.run_module` resolves packages against sys.path, which by default
# gets this *script's* directory, not the process's cwd -- so without this,
# it can't find the fish-speech submodule's own "tools" package when this
# wrapper lives outside it (as it must, to survive a fresh clone).
sys.path.insert(0, os.getcwd())

import torch._inductor.config as inductor_config

inductor_config.use_static_cuda_launcher = False

sys.argv = ["api_server.py", "--compile"]

import runpy

runpy.run_module("tools.api_server", run_name="__main__")
