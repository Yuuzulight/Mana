"""Loudness-normalizes every voice reference in references/ to -27 LUFS.

Run after adding new reference audio (uses the tts-service venv):

  .\\venv\\Scripts\\python.exe normalize-references.py

Keeps files as 16-bit PCM so the Chatterbox loader always sees float32.
Runtime loudness normalization is disabled in service.py (dtype bug in
chatterbox-tts 0.1.7 turbo), so this offline pass is what keeps reference
levels consistent.
"""
import os

import numpy as np
import pyloudnorm as ln
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
REFERENCES = os.path.join(HERE, "references")
TARGET_LUFS = -27.0

for name in sorted(os.listdir(REFERENCES)):
    if not name.lower().endswith(".wav"):
        continue
    path = os.path.join(REFERENCES, name)
    audio, sr = sf.read(path, dtype="float32")
    meter = ln.Meter(sr)
    loudness = meter.integrated_loudness(audio.astype(np.float64))
    gain = 10.0 ** ((TARGET_LUFS - loudness) / 20.0)
    if np.isfinite(gain) and gain > 0:
        audio = np.clip(audio * np.float32(gain), -1.0, 1.0)
    sf.write(path, audio, sr, subtype="PCM_16")
    print(f"{name}: {loudness:.1f} LUFS -> {TARGET_LUFS}")
