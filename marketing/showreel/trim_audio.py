"""Trims the source track to start on its real detected downbeat (see
analyze_beats.py) instead of the ~8s ambient lead-in before the beat
pattern locks in. Run: python trim_audio.py
"""

import pathlib
import librosa
import soundfile as sf

HERE = pathlib.Path(__file__).parent
SRC = HERE / "audio" / "im-fine.mp3"
OUT = HERE / "audio" / "im-fine-trimmed.wav"

DOWNBEAT_SEC = 8.022  # from analyze_beats.py's downbeat_anchor_sec
LOOP_T = 1.9969 * 8   # BAR_DUR * BARS, kept in sync with showreel.html
TAIL_BUFFER_SEC = 0.5  # room for ffmpeg's tmix/select edge effects


def main():
    y, sr = librosa.load(SRC, sr=None, mono=False)
    start = int(DOWNBEAT_SEC * sr)
    end = int((DOWNBEAT_SEC + LOOP_T + TAIL_BUFFER_SEC) * sr)
    clip = y[:, start:end] if y.ndim == 2 else y[start:end]
    sf.write(OUT, clip.T if y.ndim == 2 else clip, sr)
    print(f"wrote {OUT} ({(end - start) / sr:.3f}s)")


if __name__ == "__main__":
    main()
