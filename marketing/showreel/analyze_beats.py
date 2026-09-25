"""Beat-grid analysis for the showreel's audio track.

Detects tempo, onset-derived beat positions, and the first downbeat, then
prints the 8-bar grid the showreel's seek(t) timeline is built against.
Run: python analyze_beats.py audio/im-fine.mp3
"""

import sys
import json
import numpy as np
import librosa


def analyze(path):
    y, sr = librosa.load(path, sr=None, mono=True)
    duration = librosa.get_duration(y=y, sr=sr)

    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, units="frames")
    beat_times = librosa.frames_to_time(beat_frames, sr=sr)
    tempo = float(np.atleast_1d(tempo)[0])

    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    onset_frames = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr)
    onset_times = librosa.frames_to_time(onset_frames, sr=sr)

    # First strong onset near the start = the track's real downbeat, not
    # necessarily t=0 (most stock tracks have a fraction of a second of
    # lead-in silence/room tone).
    first_onset = float(onset_times[0]) if len(onset_times) else 0.0

    # Snap the detected beat grid so beat[0] sits on first_onset, then
    # derive bar starts (every 4 beats, 4/4 assumed) from that anchor.
    if len(beat_times) > 0:
        anchor = float(beat_times[0])
    else:
        anchor = first_onset

    sec_per_beat = 60.0 / tempo
    bar_starts = [anchor + i * 4 * sec_per_beat for i in range(9)]  # 8 bars + loop point

    return {
        "duration_sec": round(float(duration), 3),
        "tempo_bpm": round(tempo, 2),
        "sec_per_beat": round(sec_per_beat, 4),
        "sec_per_bar": round(sec_per_beat * 4, 4),
        "first_onset_sec": round(first_onset, 3),
        "downbeat_anchor_sec": round(anchor, 3),
        "detected_beat_times_sec": [round(float(t), 3) for t in beat_times[:16]],
        "bar_starts_sec": [round(t, 3) for t in bar_starts],
        "total_8_bars_sec": round(bar_starts[8] - bar_starts[0], 3),
    }


if __name__ == "__main__":
    result = analyze(sys.argv[1])
    print(json.dumps(result, indent=2))
