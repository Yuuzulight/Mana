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

# Host-RAM fix: upstream builds both models on the CPU in fp32 with random
# init (S1-mini LLaMA ~3.5GB, codec ~1.9GB) and only then swaps in the real
# weights and moves them to the GPU, so loading briefly needs ~5.4GB of
# system RAM for tensors that are thrown away. Constructing under
# torch.device(device) puts that throwaway copy on the GPU instead (same
# final weights, dtype and device -- no voice/speed change); empty_cache()
# then hands the freed VRAM back. Must run before tools.server.model_manager
# imports load_model by name.
import numpy as np
import torch
from fish_speech.models.dac import inference as dac_inference
from fish_speech.models.text2semantic import inference as t2s_inference
from fish_speech.models.text2semantic.llama import KVCache

_init_llama = t2s_inference.init_model
_load_codec = dac_inference.load_model


# #807: parking (POST /admin/device, which calls model.to(device) on both
# models) cost more host RAM than the weights and kept some of it after
# unparking. Two causes, both handled here for the parking moves only:
# - torch's CPU allocator on Windows (bundled mimalloc) never returns or
#   reuses large freed blocks (~300MB embeddings, the codec's 256MB mask), so
#   every park/unpark cycle left them behind. The parked copies are numpy
#   buffers instead, which go back to the OS when unparking drops them.
# - The llama KV caches (~0.9GB) are scratch space every request overwrites,
#   so parking drops them instead of copying them, and unparking allocates
#   zeroed ones on the GPU, the same state they start in after loading.
def _park_aware_to(model):
    def to(device):
        device = torch.device(device)
        # Same replacement rules as nn.Module._apply: parameters keep their
        # object (.data swap), buffers are replaced.
        for m in model.modules():
            for store in (m._parameters, m._buffers):
                for name, t in store.items():
                    if t is None or t.device.type == device.type:
                        continue
                    if isinstance(m, KVCache):
                        if device.type == "cpu":
                            m.parked_shape = t.shape
                            new = torch.empty(0, dtype=t.dtype)
                        else:
                            new = torch.zeros(m.parked_shape, dtype=t.dtype, device=device)
                    elif device.type == "cpu":
                        buf = torch.from_numpy(np.empty(t.nbytes, np.uint8))
                        new = buf.view(t.dtype).view(t.shape).copy_(t)
                    else:
                        new = t.to(device)
                    if store is m._parameters:
                        t.data = new
                    else:
                        store[name] = new
        return model

    model.to = to
    return model


def _init_llama_on_device(checkpoint_path, device, precision, compile=False):
    with torch.device(device):
        model, decode_one_token = _init_llama(checkpoint_path, device, precision, compile=compile)
    torch.cuda.empty_cache()
    return _park_aware_to(model), decode_one_token


def _load_codec_on_device(config_name, checkpoint_path, device="cuda"):
    with torch.device(device):
        model = _load_codec(config_name, checkpoint_path, device)
    torch.cuda.empty_cache()
    return _park_aware_to(model)


t2s_inference.init_model = _init_llama_on_device
dac_inference.load_model = _load_codec_on_device

if __name__ == "__main__":
    sys.argv = ["api_server.py", "--compile"]

    import runpy

    runpy.run_module("tools.api_server", run_name="__main__")
