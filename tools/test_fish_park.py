"""Self-check for the Fish parking moves in fish_speech_native_server.py
(#807). Needs the fish-speech venv and a CUDA GPU. Run from tools/fish-speech:

    .venv-native\\Scripts\\python.exe ..\\test_fish_park.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import torch  # noqa: E402
from torch import nn  # noqa: E402

from fish_speech_native_server import KVCache, _park_aware_to  # noqa: E402


def run():
    model = nn.Module()
    model.lin = nn.Linear(4, 3)
    model.register_buffer("mask", torch.tril(torch.ones(5, 5, dtype=torch.bool)))
    model.cache = KVCache(1, 16, 2, 8, dtype=torch.bfloat16)
    model = _park_aware_to(model.cuda())
    weight = model.lin.weight
    expected = weight.detach().clone()

    assert model.to(device="cpu") is model
    assert weight.device.type == "cpu" and torch.equal(weight, expected.cpu())
    assert model.mask.device.type == "cpu" and bool(model.mask[4, 0]) and not bool(model.mask[0, 4])
    assert model.cache.k_cache.numel() == 0 and model.cache.v_cache.numel() == 0

    model.to("cuda")
    assert model.lin.weight is weight and weight.is_cuda and torch.equal(weight, expected)
    assert model.mask.is_cuda
    assert model.cache.k_cache.shape == (1, 2, 16, 8) and model.cache.k_cache.is_cuda
    assert model.cache.v_cache.dtype == torch.bfloat16 and not model.cache.v_cache.any()

    print("fish park: all checks passed")


if __name__ == "__main__":
    run()
