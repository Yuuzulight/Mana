#!/usr/bin/env python3
"""Download openWakeWord's pre-computed negative training features.

Phase 2 of issue #342's custom wake-word training pipeline (see README.md
in this directory): rather than assembling and featurizing a raw negative
audio corpus from scratch, reuse the features openWakeWord's own team
already computed from a 2,000-hour slice of the ACAV100M dataset -- the
same files their own training notebook downloads
(notebooks/automatic_model_training.ipynb in dscripka/openWakeWord).
"""
import argparse
from pathlib import Path

import requests

DEFAULT_OUT_DIR = Path(__file__).parent / "data" / "negative"

# (filename, URL, expected size in bytes) -- size confirmed via a HEAD
# request against these exact URLs on 2026-09-14. These are frozen,
# versioned training-data releases (not a rolling target), so a byte-size
# mismatch after download means a truncated transfer, not a legitimately
# updated upstream file.
TRAINING_SET = (
    "openwakeword_features_ACAV100M_2000_hrs_16bit.npy",
    "https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/openwakeword_features_ACAV100M_2000_hrs_16bit.npy",
    17_280_000_128,
)
VALIDATION_SET = (
    "validation_set_features.npy",
    "https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/validation_set_features.npy",
    184_836_608,
)

CHUNK_SIZE = 8 * 1024 * 1024  # 8MB


def download(name: str, url: str, expected_size: int, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / name

    if dest.exists() and dest.stat().st_size == expected_size:
        print(f"{name}: already downloaded ({expected_size:,} bytes), skipping")
        return dest

    tmp_dest = dest.with_suffix(dest.suffix + ".part")
    resume_from = tmp_dest.stat().st_size if tmp_dest.exists() else 0
    headers = {"Range": f"bytes={resume_from}-"} if resume_from else {}

    with requests.get(url, stream=True, headers=headers, timeout=60) as response:
        response.raise_for_status()
        if resume_from and response.status_code != 206:
            # Server ignored the Range request (plain 200 response) --
            # restart clean instead of corrupting the file by appending.
            print(f"{name}: server doesn't support resume, restarting from scratch")
            resume_from = 0

        mode = "ab" if resume_from else "wb"
        downloaded = resume_from
        last_pct = -1
        resuming_note = f", resuming from {resume_from / 1e9:.2f} GB" if resume_from else ""
        print(f"Downloading {name} ({expected_size / 1e9:.2f} GB){resuming_note}")

        with open(tmp_dest, mode) as f:
            for chunk in response.iter_content(chunk_size=CHUNK_SIZE):
                f.write(chunk)
                downloaded += len(chunk)
                pct = int(downloaded * 100 / expected_size)
                if pct != last_pct and pct % 5 == 0:
                    print(f"  {name}: {pct}%")
                    last_pct = pct

    actual_size = tmp_dest.stat().st_size
    if actual_size != expected_size:
        raise RuntimeError(
            f"{name}: downloaded {actual_size:,} bytes, expected {expected_size:,} -- "
            f"transfer incomplete, rerun this script to resume (partial file kept at {tmp_dest})."
        )

    tmp_dest.rename(dest)
    print(f"{name}: verified, {actual_size:,} bytes")
    return dest


def self_check(paths: list[Path], expected_sizes: dict[str, int]) -> None:
    assert paths, "no files were requested"
    for path in paths:
        assert path.exists(), f"{path.name}: missing after download"
        actual = path.stat().st_size
        expected = expected_sizes[path.name]
        assert actual == expected, f"{path.name}: {actual} bytes, expected {expected}"
    print(f"self-check passed: {len(paths)} file(s) verified")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument(
        "--skip-training-set",
        action="store_true",
        help="Only download the 185MB validation set, skipping the 17.3GB training set.",
    )
    args = parser.parse_args()

    targets = [VALIDATION_SET] if args.skip_training_set else [TRAINING_SET, VALIDATION_SET]

    paths = [download(name, url, size, args.out_dir) for name, url, size in targets]
    self_check(paths, {name: size for name, _, size in targets})


if __name__ == "__main__":
    main()
