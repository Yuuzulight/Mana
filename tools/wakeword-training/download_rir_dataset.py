#!/usr/bin/env python3
"""Download room impulse responses for wake-word training augmentation.

Phase 3 (part 1) of issue #342's custom wake-word training pipeline (see
README.md in this directory): downloads MIT's environmental impulse
response recordings, which openWakeWord's trainer convolves with the
synthetic positive clips (phase 1) to simulate playback in a real room
instead of a dry studio recording. Already resampled to 16kHz by the
dataset's own author -- no further processing needed.
"""
import sys
from pathlib import Path

import requests
import soundfile as sf

sys.path.insert(0, str(Path(__file__).parent))
from download_negative_features import download  # noqa: E402

REPO_TREE_URL = (
    "https://huggingface.co/api/datasets/"
    "davidscripka/MIT_environmental_impulse_responses/tree/main/16khz"
)
RESOLVE_BASE = (
    "https://huggingface.co/datasets/"
    "davidscripka/MIT_environmental_impulse_responses/resolve/main/16khz"
)

DEFAULT_OUT_DIR = Path(__file__).parent / "data" / "rir"


def list_remote_files() -> list[tuple[str, int]]:
    response = requests.get(REPO_TREE_URL, timeout=30)
    response.raise_for_status()
    entries = response.json()
    return [(e["path"].split("/")[-1], e["size"]) for e in entries if e["type"] == "file"]


def self_check(paths: list[Path]) -> None:
    assert paths, "no RIR files were downloaded"
    for wav_path in paths:
        data, sample_rate = sf.read(wav_path)
        assert sample_rate == 16000, f"{wav_path.name}: sample rate {sample_rate} != 16000"
        assert len(data) > 0, f"{wav_path.name}: empty clip"
    print(f"self-check passed: {len(paths)} RIR clips, all 16kHz")


def main() -> None:
    out_dir = DEFAULT_OUT_DIR
    files = list_remote_files()
    print(f"Found {len(files)} RIR files ({sum(size for _, size in files) / 1e6:.1f} MB total)")

    paths = [
        download(name, f"{RESOLVE_BASE}/{name}", size, out_dir) for name, size in files
    ]
    self_check(paths)


if __name__ == "__main__":
    main()
