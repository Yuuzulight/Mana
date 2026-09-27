"""Picks one take per narration line from audio/narration/takes/: a take must
transcribe (whisper-cli) back to its script line -- S1-mini sometimes stops
early or reads a delivery tag aloud -- and the closest match wins, ties
going to the widest pitch range (a rough proxy for "least monotone").
Japanese exclamations are checked in Japanese and ranked by how high and
lively the voice is instead (a rough proxy for "excited").
Writes the winners to audio/narration/<key>.wav.
Run: python pick_takes.py [key ...]
"""

import difflib
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

import librosa
import numpy as np
import soundfile as sf

from narrate import EXTRA_SEEDS, LINES, SEEDS

HERE = pathlib.Path(__file__).parent
REPO = HERE.parents[1]
TAKES = HERE / "audio" / "narration" / "takes"
WHISPER = REPO / "tools" / "whisper" / "Release" / "whisper-cli.exe"
WHISPER_MODEL = REPO / "tools" / "whisper" / "models" / "ggml-base.bin"
MIN_MATCH = 0.85
MAX_RANGE = 16.0  # semitones; beyond the expressive reference clips' own range reads as a pitch glitch
JA_LINES = {"13-otsumana": "おつまな"}  # key -> the kana Whisper (-l ja) should hear
MIN_JA_MATCH = 0.5  # Whisper's base model spells short Japanese loosely (katakana, small kana)


def words(s):
    s = s.lower().replace("42", "forty two").replace("-", " ").replace("'s ", " is ")
    return re.sub(r"[^a-z' ]", " ", s).split()


def kana(s):
    """Hiragana only: katakana folded down, everything else dropped."""
    s = "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in s)
    return re.sub(r"[^ぁ-ゖ]", "", s)


def transcribe(path, tmp, lang):
    y, _ = librosa.load(path, sr=16000, mono=True)
    wav16 = pathlib.Path(tmp) / "t.wav"
    sf.write(wav16, y, 16000)
    out = subprocess.run([str(WHISPER), "-m", str(WHISPER_MODEL), "-f", str(wav16), "-l", lang, "-nt", "-np"],
                         capture_output=True, text=True, encoding="utf-8")
    return " ".join(out.stdout.split())


def pitch_stats(path):
    """(95-5 percentile range in semitones, mean pitch in semitones above 220Hz)."""
    y, sr = librosa.load(path, sr=22050, mono=True)
    f0, _, _ = librosa.pyin(y, fmin=120, fmax=600, sr=sr)
    f0 = f0[~np.isnan(f0)]
    if len(f0) < 10:
        return 0.0, -99.0
    st = 12 * np.log2(f0 / np.median(f0))
    return float(np.percentile(st, 95) - np.percentile(st, 5)), float(np.mean(12 * np.log2(f0 / 220)))


def main():
    only = set(sys.argv[1:])
    with tempfile.TemporaryDirectory() as tmp:
        for key, text, tag in LINES:
            if only and key not in only:
                continue
            best = None
            for seed in EXTRA_SEEDS.get(key, SEEDS):
                take = TAKES / f"{key}-s{seed}.wav"
                if not take.exists():
                    continue
                if key in JA_LINES:
                    heard = transcribe(take, tmp, "ja")
                    match = difflib.SequenceMatcher(None, JA_LINES[key], kana(heard)).ratio()
                    ok = match >= MIN_JA_MATCH
                    rng, bright = pitch_stats(take) if ok else (0.0, -99.0)
                    # gusto = sitting high AND moving (a high but flat take reads as a held squeal),
                    # plus the stretch of a "Gii muriiin!"-style delivery
                    score = (bright + 0.3 * rng + 2.0 * sf.info(take).duration,)
                else:
                    heard = transcribe(take, tmp, "en")
                    want, got = words(text), words(heard)
                    match = difflib.SequenceMatcher(None, want, got).ratio()
                    tag_read_aloud = bool(tag) and any(w in got and w not in want for w in words(tag))
                    extra_words = len(got) > len(want)  # e.g. a delivery tag read aloud, garbled
                    ok = match >= MIN_MATCH and not tag_read_aloud and not extra_words
                    rng, bright = pitch_stats(take) if ok else (0.0, -99.0)
                    score = (match, rng)  # closest to the script (a misheard "Manna" loses), then widest range
                ok = ok and rng <= MAX_RANGE
                print(f"  {key} s{seed}: match {match:.2f}  range {rng:5.1f}st  bright {bright:+5.1f}st  \"{heard}\"")
                if ok and (best is None or score > best[1]):
                    best = (take, score)
            if best is None:
                print(f"{key}: NO USABLE TAKE")
                continue
            shutil.copyfile(best[0], HERE / "audio" / "narration" / f"{key}.wav")
            print(f"{key}: -> {best[0].name}")


if __name__ == "__main__":
    main()
