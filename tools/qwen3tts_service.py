"""Mana's Qwen3-TTS voice (TTS_PROVIDER=qwen3tts, see docs/qwen3_tts.md).

Qwen3-TTS-12Hz-0.6B-Base through faster-qwen3-tts (CUDA graphs), cloning
Mana's voice in ICL mode from a reference clip plus its transcript (the same
ones Fish uses unless QWEN3_TTS_REF_* say otherwise). node-bot posts
{"text", "language"} to /synthesize and gets a WAV back. Run it with
tools/qwen3-tts/.venv's python; the native launcher does that for you.
"""

import io
import os
import threading
from urllib.parse import urlsplit

# The weights are on disk already; never reach out to the Hub.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.responses import Response  # noqa: E402
from pydantic import BaseModel  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.environ.get("QWEN3_TTS_MODEL_DIR") or os.path.join(
    HERE, "qwen3-tts", "models", "Qwen3-TTS-12Hz-0.6B-Base"
)
REF_AUDIO = os.environ.get("QWEN3_TTS_REF_AUDIO") or os.environ.get("FISH_TTS_REF_AUDIO", "")
REF_TEXT = os.environ.get("QWEN3_TTS_REF_TEXT") or os.environ.get("FISH_TTS_REF_TEXT", "")
# #914: other characters' clips live under node-bot/data (beside
# characters.json), so a request can't point the service at any other file.
VOICES_DIR = os.path.realpath(os.path.join(HERE, "..", "node-bot", "data"))
# The same setting node-bot calls; only its port is used here, the bind is
# always loopback.
PORT = urlsplit(os.environ.get("QWEN3_TTS_URL") or "http://127.0.0.1:5012").port or 5012
# Static KV cache length for the CUDA graphs. 1024 keeps resident VRAM around
# +2.7 GB (the default 2048 roughly doubles the cache) and still fits a long
# sentence plus the ~9 s reference prompt; generation just stops at the cap.
MAX_SEQ_LEN = 1024

app = FastAPI(title="Mana Qwen3-TTS")
model = None
# One generation at a time: the CUDA graphs and static cache are shared.
lock = threading.Lock()


class SynthesizeBody(BaseModel):
    text: str
    # A detectTtsLanguage() name ("english", "japanese", ...) or "auto".
    language: str | None = None
    # #914: another character's voice -- a reference clip and its exact
    # transcript, both or neither. The same model clones it; only the first
    # sentence in a new voice pays to encode the clip.
    ref_audio: str | None = None
    ref_text: str | None = None


def patch_rope_theta():
    """Known break: qwen-tts-hf 0.1.1.post1's RoPE compat shim reads
    config.rope_theta, but transformers 5.17's MimiConfig (the speech
    tokenizer) keeps it in config.rope_parameters, so loading fails with
    AttributeError. Copy it across at call time; once either side is fixed
    rope_theta exists and this passes straight through."""
    import qwen_tts._transformers_compat as compat
    from transformers.modeling_rope_utils import ROPE_INIT_FUNCTIONS

    original = compat._default_rope_parameters

    def default_rope_parameters(config, *args, **kwargs):
        if not hasattr(config, "rope_theta"):
            config.rope_theta = (config.rope_parameters or {})["rope_theta"]
        return original(config, *args, **kwargs)

    compat._default_rope_parameters = default_rope_parameters
    if ROPE_INIT_FUNCTIONS.get("default") is original:
        ROPE_INIT_FUNCTIONS["default"] = default_rope_parameters


def synthesize_wav(tts, text, language, ref_audio=None, ref_text=None):
    """One clone generation -> WAV bytes. faster-qwen3-tts caches the encoded
    reference per (ref_audio, ref_text), so only the first call pays for it."""
    import torch

    if not text.strip():
        raise ValueError("No text provided")
    if bool(ref_audio) != bool(ref_text):
        raise ValueError("ref_audio and ref_text go together")
    if ref_audio:
        ref_audio = os.path.realpath(ref_audio)
        if not ref_audio.startswith(VOICES_DIR + os.sep) or not os.path.isfile(ref_audio):
            raise ValueError(f"Reference clip must be a file under {VOICES_DIR}")
    with lock:
        try:
            wavs, sample_rate = tts.generate_voice_clone(
                text=text,
                language=language or "auto",
                ref_audio=ref_audio or REF_AUDIO,
                ref_text=ref_text or REF_TEXT,
            )
        finally:
            # Hand the generation's scratch VRAM back (peaks ~1 GB above
            # resident) instead of letting torch's caching allocator keep it.
            torch.cuda.empty_cache()
    audio = np.concatenate([np.asarray(w, dtype=np.float32).reshape(-1) for w in wavs])
    buffer = io.BytesIO()
    sf.write(buffer, audio, sample_rate, format="WAV")
    return buffer.getvalue()


def load_model():
    if not (REF_AUDIO and REF_TEXT):
        raise SystemExit("Set QWEN3_TTS_REF_AUDIO and QWEN3_TTS_REF_TEXT (or FISH_TTS_REF_*); see docs/qwen3_tts.md")
    patch_rope_theta()
    from faster_qwen3_tts import FasterQwen3TTS

    tts = FasterQwen3TTS.from_pretrained(MODEL_DIR, max_seq_len=MAX_SEQ_LEN, local_files_only=True)
    tts.warmup(prefill_len=100)  # captures the CUDA graphs
    # Encodes and caches the clone prompt now, not on Mana's first reply.
    synthesize_wav(tts, "Ready.", "english")
    return tts


def trim_working_set():
    """#904: once warm, only ~0.12 GB of the ~2.5 GB start-up working set
    (CUDA/cuDNN DLL pages, import- and load-time heap) is touched again while
    speaking. Hand the rest back to Windows so it isn't held in RAM next to a
    game. The 256 MB minimum keeps that hot part from being trimmed again
    under memory pressure: trimming alone cost ~0.06 s per short sentence in
    the bench, with the floor latency matched the untrimmed service."""
    if os.name != "nt":
        return False
    import ctypes

    # c_void_p(-1): the current-process pseudo handle, pointer-sized.
    me = ctypes.c_void_p(-1)
    kernel32 = ctypes.windll.kernel32
    kernel32.SetProcessWorkingSetSizeEx.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_size_t, ctypes.c_uint32]
    return bool(
        ctypes.windll.psapi.EmptyWorkingSet(me)
        # Soft limits (flags 0): a floor, not a cap.
        and kernel32.SetProcessWorkingSetSizeEx(me, 256 << 20, 1024 << 20, 0)
    )


@app.get("/health")
def health():
    # Only served once load_model() has finished, so reachable means ready.
    return {"ok": True, "model": os.path.basename(MODEL_DIR), "ref_audio": os.path.basename(REF_AUDIO)}


@app.post("/synthesize")
def synthesize(body: SynthesizeBody):
    try:
        wav = synthesize_wav(model, body.text, body.language, body.ref_audio, body.ref_text)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error))
    return Response(content=wav, media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    model = load_model()
    trim_working_set()
    print(f"Qwen3-TTS ready on 127.0.0.1:{PORT}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
