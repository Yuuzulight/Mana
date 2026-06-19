import io
import os
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

DEVICE = os.environ.get("CHATTERBOX_DEVICE", "cuda")
MODEL_NAME = os.environ.get("CHATTERBOX_MODEL", "turbo")
VOICE_REF = os.environ.get("CHATTERBOX_VOICE_REF", "")
EXAGGERATION = float(os.environ.get("CHATTERBOX_EXAGGERATION", "0.35"))
CFG_WEIGHT = float(os.environ.get("CHATTERBOX_CFG_WEIGHT", "0.45"))
TEMPERATURE = float(os.environ.get("CHATTERBOX_TEMPERATURE", "0.8"))


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

    if tts_model is None:
        device = resolve_device()
        model_name = MODEL_NAME.strip().lower()

        # Quick note: Turbo uses a different class than the standard Chatterbox model.
        if model_name == "turbo":
            tts_model = ChatterboxTurboTTS.from_pretrained(device=device)
        else:
            tts_model = ChatterboxTTS.from_pretrained(device=device)
    return tts_model


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
    voice_path = voice_ref or VOICE_REF or None

    audio = model.generate(
        text=text,
        audio_prompt_path=voice_path,
        exaggeration=exaggeration,
        cfg_weight=cfg_weight,
        temperature=temperature,
    )

    if hasattr(audio, "detach"):
        audio = audio.detach().cpu().numpy()

    if getattr(audio, "ndim", 1) > 1:
        audio = audio.squeeze()

    sample_rate = getattr(model, "sr", 24000)
    buffer = io.BytesIO()
    sf.write(buffer, audio, sample_rate, format="WAV")
    return buffer.getvalue()


@app.get("/health")
def health():
    return {
        "ok": True,
        "model": MODEL_NAME,
        "device": resolve_device(),
        "voiceRefConfigured": bool(VOICE_REF),
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
