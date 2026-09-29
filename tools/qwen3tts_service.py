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


def synthesize_wav(tts, text, language):
    """One clone generation -> WAV bytes. faster-qwen3-tts caches the encoded
    reference per (ref_audio, ref_text), so only the first call pays for it."""
    import torch

    if not text.strip():
        raise ValueError("No text provided")
    with lock:
        try:
            wavs, sample_rate = tts.generate_voice_clone(
                text=text, language=language or "auto", ref_audio=REF_AUDIO, ref_text=REF_TEXT
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


@app.get("/health")
def health():
    # Only served once load_model() has finished, so reachable means ready.
    return {"ok": True, "model": os.path.basename(MODEL_DIR), "ref_audio": os.path.basename(REF_AUDIO)}


@app.post("/synthesize")
def synthesize(body: SynthesizeBody):
    try:
        wav = synthesize_wav(model, body.text, body.language)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error))
    return Response(content=wav, media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    model = load_model()
    print(f"Qwen3-TTS ready on 127.0.0.1:{PORT}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
