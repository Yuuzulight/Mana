#!/usr/bin/env python3
"""Download background noise/music for wake-word training augmentation.

Phase 3 (part 2) of issue #342's custom wake-word training pipeline (see
README.md in this directory): openWakeWord's trainer mixes background
audio under the synthetic positive clips (phase 1) so the model learns to
recognize the wake word over noise, not just in isolation. Uses MUSAN
(OpenSLR-17) rather than openWakeWord's own notebook sources (AudioSet,
FMA) -- both of those changed shape since that notebook was written
(AudioSet is now large parquet shards needing new dependencies to decode;
FMA on HuggingFace is a remote-code-execution loading script, not plain
files) and MUSAN was independently vetted as a real, small, cleanly
per-file-licensed alternative for exactly this purpose (see the comment
thread on issue #342).

Only the noise/ and music/ subsets are extracted -- MUSAN's speech/
subset isn't needed here since phase 2 already covers bulk negative
speech data at far greater scale.
"""
import sys
import tarfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from download_negative_features import download  # noqa: E402

MUSAN_URL = "https://openslr.trmal.net/resources/17/musan.tar.gz"
# Confirmed via a live HEAD request against this exact URL on 2026-09-14
# (same frozen-release reasoning as download_negative_features.py).
MUSAN_SIZE = 11_086_114_085

ARCHIVE_DIR = Path(__file__).parent / "data" / "background"
EXTRACT_DIR = ARCHIVE_DIR
WANTED_PREFIXES = ("musan/noise/", "musan/music/")


def extract_wanted_subsets(archive_path: Path, extract_dir: Path) -> list[Path]:
    extracted = []
    with tarfile.open(archive_path, "r:gz") as tar:
        members = [m for m in tar.getmembers() if m.name.startswith(WANTED_PREFIXES) and m.isfile()]
        for member in members:
            tar.extract(member, path=extract_dir, filter="data")
            extracted.append(extract_dir / member.name)
    return extracted


def self_check(paths: list[Path]) -> None:
    assert paths, "no noise/music files were extracted"
    wav_count = sum(1 for p in paths if p.suffix == ".wav")
    assert wav_count > 0, "no .wav files found in the extracted noise/music subsets"
    print(f"self-check passed: {len(paths)} files extracted ({wav_count} .wav)")


def main() -> None:
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    archive_path = download("musan.tar.gz", MUSAN_URL, MUSAN_SIZE, ARCHIVE_DIR)

    print("Extracting noise/ and music/ subsets (skipping speech/)...")
    extracted = extract_wanted_subsets(archive_path, EXTRACT_DIR)
    self_check(extracted)
    print(
        f"Extracted to {EXTRACT_DIR / 'musan' / 'noise'} and {EXTRACT_DIR / 'musan' / 'music'}. "
        f"The {MUSAN_SIZE / 1e9:.1f}GB archive at {archive_path} can be deleted now if you don't "
        "need to re-extract (e.g. to also grab speech/ later)."
    )


if __name__ == "__main__":
    main()
