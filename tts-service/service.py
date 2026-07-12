import io
import os
import threading
from typing import Optional

import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

try:
    import torch
    from chatterbox.tts import ChatterboxTTS
    from chatterbox.tts_turbo import ChatterboxTurboTTS
except Exception:
    torch = None
    ChatterboxTTS = None
    ChatterboxTurboTTS = None


app = FastAPI(title="Mana Chatterbox Turbo TTS")

tts_model = None
tts_lock = threading.Lock()

DEVICE = os.environ.get("CHATTERBOX_DEVICE", "cuda")
MODEL_NAME = os.environ.get("CHATTERBOX_MODEL", "turbo")
HERE = os.path.dirname(__file__)
# Default to Mana's personal reference voice when it exists (git-ignored,
# lives in references/). CHATTERBOX_VOICE_REF still overrides.
_DEFAULT_VOICE_REF = os.path.join(HERE, "references", "mana-mitsuki.wav")
VOICE_REF = os.environ.get(
    "CHATTERBOX_VOICE_REF",
    _DEFAULT_VOICE_REF if os.path.exists(_DEFAULT_VOICE_REF) else "",
)
EXAGGERATION = float(os.environ.get("CHATTERBOX_EXAGGERATION", "0.35"))
CFG_WEIGHT = float(os.environ.get("CHATTERBOX_CFG_WEIGHT", "0.45"))
TEMPERATURE = float(os.environ.get("CHATTERBOX_TEMPERATURE", "0.8"))
WARMUP_ENABLED = os.environ.get("CHATTERBOX_WARMUP", "1") != "0"
WARMUP_TEXT = os.environ.get("CHATTERBOX_WARMUP_TEXT", "Ready.")


class SynthesizeBody(BaseModel):
    text: str
    voice_ref: Optional[str] = None
    exaggeration: Optional[float] = None
    cfg_weight: Optional[float] = None
    temperature: Optional[float] = None


def resolve_device() -> str:
    if DEVICE == "cuda" and torch is not None and torch.cuda.is_available():
        return "cuda"
    return "cpu"


def get_model():
    global tts_model
    if ChatterboxTTS is None or ChatterboxTurboTTS is None:
        raise RuntimeError(
            "Chatterbox is not installed. Install tts-service/requirements.txt first."
        )

    with tts_lock:
        if tts_model is None:
            device = resolve_device()
            model_name = MODEL_NAME.strip().lower()

            # Quick note: Turbo uses a different class than the standard Chatterbox model.
            if model_name == "turbo":
                tts_model = ChatterboxTurboTTS.from_pretrained(device=device)
            else:
                tts_model = ChatterboxTTS.from_pretrained(device=device)
    return tts_model


def resolve_voice_ref(voice_ref: str) -> Optional[str]:
    """Accepts a full path or a bare name from the references/ voice bank."""
    ref = (voice_ref or "").strip()
    if not ref:
        return None
    if os.path.exists(ref):
        return ref
    references_dir = os.path.join(HERE, "references")
    for candidate in (ref, f"{ref}.wav"):
        candidate_path = os.path.join(references_dir, candidate)
        if os.path.exists(candidate_path):
            return candidate_path
    raise ValueError(f"Unknown voice reference: {voice_ref}")


def list_voice_bank() -> list[str]:
    references_dir = os.path.join(HERE, "references")
    if not os.path.isdir(references_dir):
        return []
    return sorted(
        os.path.splitext(name)[0]
        for name in os.listdir(references_dir)
        if name.lower().endswith(".wav")
    )


def synthesize_to_wav_bytes(
    text: str,
    voice_ref: str,
    exaggeration: float,
    cfg_weight: float,
    temperature: float,
) -> bytes:
    if not text.strip():
        raise ValueError("No text provided")

    model = get_model()
    voice_path = resolve_voice_ref(voice_ref) or resolve_voice_ref(VOICE_REF)

    generate_kwargs = dict(
        text=text,
        audio_prompt_path=voice_path,
        exaggeration=exaggeration,
        cfg_weight=cfg_weight,
        temperature=temperature,
    )
    # chatterbox-tts 0.1.7 turbo: runtime loudness normalization promotes the
    # reference to float64 and crashes with "expected scalar type Double but
    # found Float". References in references/ are loudness-normalized offline
    # instead. CHATTERBOX_NORM_LOUDNESS=1 re-enables the runtime path.
    if MODEL_NAME.strip().lower() == "turbo" and os.environ.get(
        "CHATTERBOX_NORM_LOUDNESS", "0"
    ) != "1":
        generate_kwargs["norm_loudness"] = False

    with tts_lock:
        audio = model.generate(**generate_kwargs)

    if hasattr(audio, "detach"):
        audio = audio.detach().cpu().numpy()

    if getattr(audio, "ndim", 1) > 1:
        audio = audio.squeeze()

    sample_rate = getattr(model, "sr", 24000)
    buffer = io.BytesIO()
    sf.write(buffer, audio, sample_rate, format="WAV")
    return buffer.getvalue()


def warmup_model():
    if not WARMUP_ENABLED:
        return

    try:
        # Quick note: this pays the model load/CUDA warm-up cost before Mana has to speak.
        synthesize_to_wav_bytes(
            text=WARMUP_TEXT,
            voice_ref="",
            exaggeration=EXAGGERATION,
            cfg_weight=CFG_WEIGHT,
            temperature=TEMPERATURE,
        )
        print("Chatterbox warm-up complete", flush=True)
    except Exception as error:
        print(f"Chatterbox warm-up failed: {error}", flush=True)


@app.on_event("startup")
def start_warmup():
    threading.Thread(target=warmup_model, daemon=True).start()


@app.get("/health")
def health():
    return {
        "ok": True,
        "model": MODEL_NAME,
        "device": resolve_device(),
        "voiceRefConfigured": bool(VOICE_REF),
        "activeVoice": os.path.splitext(os.path.basename(VOICE_REF))[0]
        if VOICE_REF
        else None,
    }


@app.get("/voices")
def voices():
    return {
        "active": os.path.splitext(os.path.basename(VOICE_REF))[0]
        if VOICE_REF
        else None,
        "voices": list_voice_bank(),
    }


@app.post("/synthesize")
def synthesize(body: SynthesizeBody):
    try:
        wav_bytes = synthesize_to_wav_bytes(
            text=body.text,
            voice_ref=body.voice_ref or "",
            exaggeration=body.exaggeration
            if body.exaggeration is not None
            else EXAGGERATION,
            cfg_weight=body.cfg_weight if body.cfg_weight is not None else CFG_WEIGHT,
            temperature=body.temperature
            if body.temperature is not None
            else TEMPERATURE,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error))

    return StreamingResponse(io.BytesIO(wav_bytes), media_type="audio/wav")


@app.get("/")
def root():
    return JSONResponse(
        {
            "service": "mana-chatterbox-tts",
            "model": MODEL_NAME,
            "device": resolve_device(),
        }
    )
