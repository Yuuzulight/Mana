import io
import os
import threading

import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

try:
    from kokoro_onnx import Kokoro
except Exception:
    Kokoro = None


app = FastAPI(title="Mana Kokoro TTS")

kokoro_model = None
kokoro_lock = threading.Lock()

HERE = os.path.dirname(__file__)
KOKORO_MODEL_PATH = os.environ.get(
    "KOKORO_MODEL_PATH",
    os.path.join(HERE, "kokoro", "kokoro-v1.0.int8.onnx"),
)
KOKORO_VOICES_PATH = os.environ.get(
    "KOKORO_VOICES_PATH",
    os.path.join(HERE, "kokoro", "voices-v1.0.bin"),
)
KOKORO_VOICE = os.environ.get("KOKORO_VOICE", "jf_nezumi")
KOKORO_SPEED = float(os.environ.get("KOKORO_SPEED", "1.18"))
KOKORO_LANG = os.environ.get("KOKORO_LANG", "en-us")
KOKORO_WARMUP = os.environ.get("KOKORO_WARMUP", "1") != "0"


class SynthesizeBody(BaseModel):
    text: str
    voice: str | None = None
    speed: float | None = None
    lang: str | None = None


def get_model():
    global kokoro_model
    if Kokoro is None:
        raise RuntimeError("kokoro-onnx is not installed.")

    with kokoro_lock:
        if kokoro_model is None:
            kokoro_model = Kokoro(KOKORO_MODEL_PATH, KOKORO_VOICES_PATH)
    return kokoro_model


def synthesize_to_wav_bytes(text: str, voice: str, speed: float, lang: str) -> bytes:
    if not text.strip():
        raise ValueError("No text provided")

    model = get_model()
    with kokoro_lock:
        audio, sample_rate = model.create(
            text=text,
            voice=voice,
            speed=speed,
            lang=lang,
        )

    buffer = io.BytesIO()
    sf.write(buffer, audio, sample_rate, format="WAV")
    return buffer.getvalue()


def warmup_model():
    if not KOKORO_WARMUP:
        return

    try:
        # Quick note: this loads the ONNX model before the first real reply.
        synthesize_to_wav_bytes("Ready.", KOKORO_VOICE, KOKORO_SPEED, KOKORO_LANG)
        print("Kokoro warm-up complete", flush=True)
    except Exception as error:
        print(f"Kokoro warm-up failed: {error}", flush=True)


@app.on_event("startup")
def start_warmup():
    threading.Thread(target=warmup_model, daemon=True).start()


@app.get("/health")
def health():
    return {
        "ok": True,
        "model": os.path.basename(KOKORO_MODEL_PATH),
        "voice": KOKORO_VOICE,
        "speed": KOKORO_SPEED,
        "lang": KOKORO_LANG,
    }


@app.post("/synthesize")
def synthesize(body: SynthesizeBody):
    try:
        wav_bytes = synthesize_to_wav_bytes(
            text=body.text,
            voice=body.voice or KOKORO_VOICE,
            speed=body.speed if body.speed is not None else KOKORO_SPEED,
            lang=body.lang or KOKORO_LANG,
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
            "service": "mana-kokoro-tts",
            "model": os.path.basename(KOKORO_MODEL_PATH),
            "voice": KOKORO_VOICE,
        }
    )
