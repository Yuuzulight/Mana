"""Mixes Mana's narration over the music on the timeline.json schedule,
polishing her voice and ducking the music under it. Checks that no two
lines overlap.
Run: python mix_narration.py            ->  audio/narration-mix.wav
     python mix_narration.py --ab KEY   ->  audio/polish-ab.wav (raw, then polished)
"""

import json
import pathlib
import sys

import librosa
import numpy as np
import soundfile as sf
from scipy.signal import butter, fftconvolve, lfilter, sosfilt

HERE = pathlib.Path(__file__).parent
SR = 44100
DOWNBEAT_SEC = 8.022  # same trim point as trim_audio.py
MIN_GAP = 0.2  # seconds of silence required between consecutive lines


def db(x):
    return 10 ** (x / 20)


def moving_avg(x, n):
    """Centered moving average in O(len(x)) via a running sum."""
    c = np.cumsum(np.concatenate([np.zeros(n // 2 + 1), x, np.zeros(n - n // 2)]))
    return (c[n:n + len(x)] - c[:len(x)]) / n


def peaking(x, f, q, gain_db):
    """RBJ-cookbook peaking EQ."""
    a, w = db(gain_db / 2), 2 * np.pi * f / SR
    al = np.sin(w) / (2 * q)
    b = [1 + al * a, -2 * np.cos(w), 1 - al * a]
    return lfilter(b, [1 + al / a, -2 * np.cos(w), 1 - al / a], x)


def high_shelf(x, f, gain_db, s=0.8):
    """RBJ-cookbook high shelf."""
    a, w = db(gain_db / 2), 2 * np.pi * f / SR
    al = np.sin(w) / 2 * np.sqrt((a + 1 / a) * (1 / s - 1) + 2)
    c, r = np.cos(w), 2 * np.sqrt(a) * al
    b = [a * ((a + 1) + (a - 1) * c + r), -2 * a * ((a - 1) + (a + 1) * c), a * ((a + 1) + (a - 1) * c - r)]
    return lfilter(b, [(a + 1) - (a - 1) * c + r, 2 * ((a - 1) - (a + 1) * c), (a + 1) - (a - 1) * c - r], x)


def polish(x):
    """Softens S1-mini's codec edge: its metallic ringing sits around 2-6kHz and
    its aliasing up top. Cut those, then a short, dark room reverb smears what's
    left so the voice reads as recorded rather than synthesized. It can only
    soften the codec's sound, not remove it."""
    y = sosfilt(butter(2, 90, "highpass", fs=SR, output="sos"), x)
    y = peaking(y, 3000, 1.0, -3)
    y = peaking(y, 5500, 2.0, -2)
    y = high_shelf(y, 8000, -6)
    y = sosfilt(butter(4, 13000, "lowpass", fs=SR, output="sos"), y)
    # room: 15ms pre-delay, ~0.6s RT60, darkened decaying noise
    rng = np.random.default_rng(0)
    t = np.arange(int(0.6 * SR)) / SR
    ir = sosfilt(butter(2, 5000, "lowpass", fs=SR, output="sos"), rng.standard_normal(len(t))) * np.exp(-t / 0.09)
    ir = np.concatenate([np.zeros(int(0.015 * SR)), ir / np.sqrt((ir ** 2).sum())])
    wet = fftconvolve(y, ir)[:len(y)]
    return y + wet * db(-14)


def main():
    tl = json.loads((HERE / "timeline.json").read_text(encoding="utf-8"))
    bar = tl["bar_dur"]
    total = sum(s["bars"] for s in tl["screens"]) * bar

    voice = np.zeros(int(total * SR) + SR)
    t, prev_end = 0.0, -1.0
    for s in tl["screens"]:
        # a screen carries one `line` + `offset`, or several under `lines`
        for ln in s.get("lines") or ([{"line": s["line"], "offset": s["offset"]}] if "line" in s else []):
            clip, _ = librosa.load(HERE / "audio" / "narration" / f"{ln['line']}.wav", sr=SR, mono=True)
            start = t + ln["offset"]
            assert start - prev_end >= MIN_GAP, f"{ln['line']} starts {start - prev_end:.2f}s after the previous line"
            i = int(start * SR)
            voice[i:i + len(clip)] += clip / (np.abs(clip).max() + 1e-9) * db(-3)
            prev_end = start + len(clip) / SR
            print(f"{s['key']:<11} screen {t:6.2f}-{t + s['bars'] * bar:6.2f}  line {start:6.2f}-{prev_end:6.2f}  {ln['line']}")
        t += s["bars"] * bar
    assert prev_end <= total, "last line runs past the loop point"
    voice = polish(voice[:int(total * SR)])
    # set loudness, not peak: the polish EQ strips energy without touching peaks much
    speech = np.abs(voice) > 0.01 * np.abs(voice).max()
    voice *= db(-16) / (np.sqrt((voice[speech] ** 2).mean()) + 1e-9)

    music, _ = librosa.load(HERE / "audio" / "im-fine.mp3", sr=SR, mono=True, offset=DOWNBEAT_SEC, duration=total)
    music = music / (np.abs(music).max() + 1e-9)

    # sidechain duck: -10dB bed, -19dB under her voice, with a smoothed envelope
    active = moving_avg((np.abs(voice) > 0.01).astype(float), int(0.25 * SR)) > 0
    env = moving_avg(active.astype(float), int(0.12 * SR))
    gain = db(-10) * (1 - env) + db(-19) * env
    fade = np.ones_like(music)
    n = int(0.8 * SR)
    fade[-n:] = np.linspace(1, 0, n)  # soft tail so the loop seam doesn't click
    mix = voice + music * gain * fade
    mix /= max(1.0, np.abs(mix).max() / db(-1))
    out = HERE / "audio" / "narration-mix.wav"
    sf.write(out, mix, SR)
    print(f"{total:.2f}s -> {out}")


def ab(key):
    clip, _ = librosa.load(HERE / "audio" / "narration" / f"{key}.wav", sr=SR, mono=True)
    raw = clip / (np.abs(clip).max() + 1e-9) * db(-3)
    pol = polish(raw)
    pol *= db(-3) / (np.abs(pol).max() + 1e-9)
    out = HERE / "audio" / "polish-ab.wav"
    sf.write(out, np.concatenate([raw, np.zeros(int(0.8 * SR)), pol]), SR)
    print(f"raw then polished -> {out}")


if __name__ == "__main__":
    ab(sys.argv[2]) if sys.argv[1:2] == ["--ab"] else main()
