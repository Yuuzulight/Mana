"""Mana's CosyVoice3 voice (TTS_PROVIDER=cosyvoice3, see docs/cosyvoice3_tts.md).

Fun-CosyVoice3-0.5B-2512 on tools/fast_tts's runtime, cloning Mana's voice from
a reference clip. The clip is registered once and every sentence goes through
CosyVoice's cross-lingual mode: the language model gets no prompt text to
continue, so the reference only gives the timbre and the text can be in any
language (the way the approved English voice was made). node-bot posts
{"text", "language", "emotion"} to /synthesize and gets a WAV back. Run it with
tools/cosyvoice/env's python; the native launcher does that for you.
"""

import hashlib
import io
import os
import sys
import threading
from urllib.parse import urlsplit

# The weights are on disk already; never reach out to the Hub.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

HERE = os.path.dirname(os.path.abspath(__file__))
COSYVOICE_DIR = os.environ.get("COSYVOICE3_TTS_REPO_DIR") or os.path.join(HERE, "cosyvoice", "CosyVoice")
sys.path[:0] = [COSYVOICE_DIR, os.path.join(COSYVOICE_DIR, "third_party", "Matcha-TTS"), HERE]

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.responses import Response  # noqa: E402
from pydantic import BaseModel  # noqa: E402

MODEL_DIR = os.environ.get("COSYVOICE3_TTS_MODEL_DIR") or os.path.join(
    HERE, "cosyvoice", "models", "Fun-CosyVoice3-0.5B-2512"
)
REF_AUDIO = os.environ.get("COSYVOICE3_TTS_REF_AUDIO") or os.environ.get("FISH_TTS_REF_AUDIO", "")
REF_TEXT = os.environ.get("COSYVOICE3_TTS_REF_TEXT") or os.environ.get("FISH_TTS_REF_TEXT", "")
# #914: other characters' clips live under node-bot/data (beside
# characters.json), so a request can't point the service at any other file.
VOICES_DIR = os.path.realpath(os.path.join(HERE, "..", "node-bot", "data"))
PORT = urlsplit(os.environ.get("COSYVOICE3_TTS_URL") or "http://127.0.0.1:5013").port or 5013
# Fun-CosyVoice3 wants this in front of the text it speaks and of the prompt text.
PREFIX = "You are a helpful assistant.<|endofprompt|>"
# #909: the reply's emotion tag sets her speaking rate by resampling the audio
# (faster is a little higher, slower a little lower), the same table
# qwen3tts_service.py uses. COSYVOICE3_TTS_EMOTION=off keeps one voice for every tag.
EMOTION_RATES = {} if os.environ.get("COSYVOICE3_TTS_EMOTION") == "off" else {
    "excited": 1.07,
    "surprised": 1.05,
    "happy": 1.04,
    "angry": 1.03,
    "thinking": 0.97,
    "disappointed": 0.95,
    "sad": 0.93,
}
# A fixed seed makes every sentence sample the same way; unset (the default) is random.
SEED = os.environ.get("COSYVOICE3_TTS_SEED")

app = FastAPI(title="Mana CosyVoice3")
model = None
# One generation at a time: the CUDA graphs and caches are shared.
lock = threading.Lock()
# (ref_audio, ref_text) -> the speaker id it was registered under.
voices = {}


class SynthesizeBody(BaseModel):
    text: str
    # Accepted for parity with the other voices; cross-lingual mode needs no hint.
    language: str | None = None
    emotion: str | None = None
    # #914: another character's voice, both or neither (see Qwen3-TTS).
    ref_audio: str | None = None
    ref_text: str | None = None


def change_rate(audio, rate):
    """Plays `audio` `rate` times as fast (pitch moves with it): an FFT
    resample to len/rate samples, kept at the same sample rate."""
    if rate == 1.0 or len(audio) == 0:
        return audio
    n = max(1, round(len(audio) / rate))
    return (np.fft.irfft(np.fft.rfft(audio), n) * (n / len(audio))).astype(np.float32)


def voice_id(tts, ref_audio, ref_text):
    """The reference's speaker id, registering it on first use (CosyVoice extracts its tokens and embedding once)."""
    key = (ref_audio, ref_text)
    if key not in voices:
        spk = "v" + hashlib.sha1(repr(key).encode("utf-8")).hexdigest()[:10]
        tts.add_zero_shot_spk(PREFIX + ref_text, ref_audio, spk)
        voices[key] = spk
    return voices[key]


def synthesize_wav(tts, text, language=None, emotion=None, ref_audio=None, ref_text=None):
    """One clone generation -> WAV bytes."""
    import torch

    if not text.strip():
        raise ValueError("No text provided")
    if bool(ref_audio) != bool(ref_text):
        raise ValueError("ref_audio and ref_text go together")
    if ref_audio:
        ref_audio = os.path.realpath(ref_audio)
        if not ref_audio.startswith(VOICES_DIR + os.sep) or not os.path.isfile(ref_audio):
            raise ValueError(f"Reference clip must be a file under {VOICES_DIR}")
    ref_audio, ref_text = ref_audio or REF_AUDIO, ref_text or REF_TEXT
    with lock:
        try:
            if SEED is not None:
                torch.manual_seed(int(SEED))
            chunks = [
                np.asarray(out["tts_speech"].detach().float().cpu().numpy(), dtype=np.float32).reshape(-1)
                for out in tts.inference_cross_lingual(
                    PREFIX + text, ref_audio, zero_shot_spk_id=voice_id(tts, ref_audio, ref_text), stream=True
                )
            ]
        finally:
            # Hand the generation's scratch VRAM back instead of letting
            # torch's caching allocator keep it.
            torch.cuda.empty_cache()
    if not chunks:
        raise RuntimeError("CosyVoice3 returned no audio")
    audio = change_rate(np.concatenate(chunks), EMOTION_RATES.get(emotion, 1.0))
    buffer = io.BytesIO()
    sf.write(buffer, audio, tts.sample_rate, format="WAV")
    return buffer.getvalue()


def load_model():
    if not (REF_AUDIO and REF_TEXT):
        raise SystemExit("Set COSYVOICE3_TTS_REF_AUDIO and COSYVOICE3_TTS_REF_TEXT (or FISH_TTS_REF_*); see docs/cosyvoice3_tts.md")
    from cosyvoice.cli.cosyvoice import AutoModel

    tts = AutoModel(model_dir=MODEL_DIR, fp16=True)
    try:
        from fast_tts import cosyvoice as fast_cosyvoice

        fast_cosyvoice.enable(tts)
    except Exception as error:  # the plain runtime still speaks, about twice as slowly
        print(f"fast_tts unavailable, using CosyVoice's own runtime: {error}", flush=True)
    # Registers the reference and captures the CUDA graphs now (a short and a
    # longer sentence, the graphs being one a shape), not on Mana's first reply.
    synthesize_wav(tts, "Ready.")
    synthesize_wav(tts, "Good morning! I made some tea, and I was thinking we could sit by the window.")
    return tts


def trim_working_set():
    """#904: once warm, only a small part of the start-up working set is
    touched again while speaking. Hand the rest back to Windows so it isn't
    held in RAM next to a game (the same floor qwen3tts_service.py keeps)."""
    if os.name != "nt":
        return False
    import ctypes

    me = ctypes.c_void_p(-1)
    kernel32 = ctypes.windll.kernel32
    kernel32.SetProcessWorkingSetSizeEx.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_size_t, ctypes.c_uint32]
    return bool(
        ctypes.windll.psapi.EmptyWorkingSet(me)
        and kernel32.SetProcessWorkingSetSizeEx(me, 256 << 20, 1024 << 20, 0)
    )


@app.get("/health")
def health():
    # Only served once load_model() has finished, so reachable means ready.
    return {"ok": True, "model": os.path.basename(MODEL_DIR), "ref_audio": os.path.basename(REF_AUDIO)}


@app.post("/synthesize")
def synthesize(body: SynthesizeBody):
    try:
        wav = synthesize_wav(model, body.text, body.language, body.emotion, body.ref_audio, body.ref_text)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error))
    return Response(content=wav, media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    model = load_model()
    trim_working_set()
    print(f"CosyVoice3 ready on 127.0.0.1:{PORT}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
