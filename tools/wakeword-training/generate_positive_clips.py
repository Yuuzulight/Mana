#!/usr/bin/env python3
"""Generate synthetic "Mana" wake-word clips via the local Kokoro TTS model.

Phase 1 of issue #342's custom wake-word training pipeline (see README.md in
this directory for the full plan): produces positive training examples by
synthesizing the wake phrase across Kokoro's English voices and a few speed
variants. Reuses the Kokoro model already bundled for tts-service -- no
network access, no API key, nothing new to download.
"""
import argparse
import sys
from math import gcd
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro
from scipy.signal import resample_poly

REPO_ROOT = Path(__file__).resolve().parents[2]
TTS_SERVICE_DIR = REPO_ROOT / "tts-service"
DEFAULT_MODEL_PATH = TTS_SERVICE_DIR / "kokoro" / "kokoro-v1.0.int8.onnx"
DEFAULT_VOICES_PATH = TTS_SERVICE_DIR / "kokoro" / "voices-v1.0.bin"

# American + British, female + male. Kokoro also ships Japanese/Chinese/
# Spanish/French/Hindi/Italian/Portuguese voices, but the wake phrase itself
# is English, so those would mostly test an ONNX language-cross-talk edge
# case rather than add useful speaker diversity for this model.
ENGLISH_VOICE_PREFIXES = ("af_", "am_", "bf_", "bm_")

# Matches SileroVadRunner.cs and the rest of this repo's VAD pipeline, and
# is what wake-word classifiers (e.g. openWakeWord) expect as input.
TARGET_SAMPLE_RATE = 16000


def english_voices(model: Kokoro) -> list[str]:
    return sorted(v for v in model.get_voices() if v.startswith(ENGLISH_VOICE_PREFIXES))


def resample_to_16k(audio: np.ndarray, source_rate: int) -> np.ndarray:
    if source_rate == TARGET_SAMPLE_RATE:
        return audio
    divisor = gcd(source_rate, TARGET_SAMPLE_RATE)
    return resample_poly(audio, TARGET_SAMPLE_RATE // divisor, source_rate // divisor)


def generate(
    phrase: str, voices: list[str], speeds: list[float], out_dir: Path, model: Kokoro
) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    slug = phrase.lower().replace(" ", "-")
    written = []
    for voice in voices:
        for speed in speeds:
            audio, sample_rate = model.create(text=phrase, voice=voice, speed=speed, lang="en-us")
            audio_16k = resample_to_16k(audio, sample_rate)
            path = out_dir / f"{slug}_{voice}_spd{speed:.2f}.wav"
            sf.write(path, audio_16k, TARGET_SAMPLE_RATE, subtype="PCM_16")
            written.append(path)
    return written


def self_check(paths: list[Path]) -> None:
    assert paths, "no clips were generated"
    for wav_path in paths:
        data, sample_rate = sf.read(wav_path)
        assert sample_rate == TARGET_SAMPLE_RATE, (
            f"{wav_path.name}: sample rate {sample_rate} != {TARGET_SAMPLE_RATE}"
        )
        assert data.ndim == 1, f"{wav_path.name}: expected mono, got shape {data.shape}"
        assert len(data) > 0, f"{wav_path.name}: empty clip"
    print(f"self-check passed: {len(paths)} clips, all {TARGET_SAMPLE_RATE}Hz mono")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--phrase",
        action="append",
        dest="phrases",
        help="Wake phrase to synthesize (repeatable). Default: 'Mana' and 'Hey Mana'.",
    )
    parser.add_argument(
        "--speeds",
        type=float,
        nargs="+",
        default=[0.85, 1.0, 1.15],
        help="Kokoro speed multipliers to synthesize at (default: %(default)s)",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path(__file__).parent / "data" / "positive",
        help="Output directory for generated WAV clips",
    )
    parser.add_argument("--model-path", type=Path, default=DEFAULT_MODEL_PATH)
    parser.add_argument("--voices-path", type=Path, default=DEFAULT_VOICES_PATH)
    args = parser.parse_args()

    phrases = args.phrases or ["Mana", "Hey Mana"]

    if not args.model_path.exists() or not args.voices_path.exists():
        sys.exit(
            f"Kokoro model files not found at {args.model_path} / {args.voices_path}. "
            "This script reuses tts-service's already-downloaded Kokoro model -- "
            "run tts-service's own setup first if these are missing."
        )

    model = Kokoro(str(args.model_path), str(args.voices_path))
    voices = english_voices(model)
    print(f"Generating {len(phrases)} phrase(s) x {len(voices)} voices x {len(args.speeds)} speeds...")

    written = []
    for phrase in phrases:
        written.extend(generate(phrase, voices, args.speeds, args.out_dir, model))

    print(f"Wrote {len(written)} clips to {args.out_dir}")
    self_check(written)


if __name__ == "__main__":
    main()
