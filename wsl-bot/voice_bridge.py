#!/usr/bin/env python3
"""
voice_bridge.py
Simple FastAPI service that exposes:
 - POST /transcribe -> accepts multipart-form wav audio, returns transcription and model response
 - POST /synthesize  -> accepts JSON {"text": "..."} and returns synthesized WAV

This script uses faster-whisper for transcription and Coqui TTS for synthesis.
It will also attempt to forward transcribed text to a local text-generation-webui instance
running at http://localhost:7860 using common API paths (/api/chat, /api/generate).

Notes / assumptions:
- text-generation-webui must be running in WSL (or otherwise accessible on localhost:7860).
- The webui API endpoint shapes can vary. This bridge tries some common forms, but you may
  need to adjust `query_model()` if your webui differs.

Run with:
  uvicorn voice_bridge:app --host 0.0.0.0 --port 5005 --workers 1

"""

import asyncio
import io
import os

import numpy as np
import requests
import soundfile as sf
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

# faster-whisper & TTS imports
try:
    from faster_whisper import WhisperModel
except Exception as e:
    WhisperModel = None

try:
    from TTS.api import TTS
except Exception as e:
    TTS = None

app = FastAPI(title="Voice bridge for local bot")

# Global model instances (initialized lazily)
whisper_model = None
tts_model = None

WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "cuda")
TTS_DEVICE = os.environ.get("TTS_DEVICE", "cuda")

MODEL_HOST = os.environ.get("WEBUI_HOST", "http://localhost:7860")


def init_whisper():
    global whisper_model
    if WhisperModel is None:
        raise RuntimeError(
            "faster-whisper not available. Install requirements in the WSL venv."
        )
    if whisper_model is None:
        # small model for speed; change to medium if you prefer accuracy
        whisper_model = WhisperModel(
            "small", device=WHISPER_DEVICE, compute_type="float16"
        )
    return whisper_model


def init_tts():
    global tts_model
    if TTS is None:
        raise RuntimeError(
            "Coqui TTS not available. Install requirements in the WSL venv."
        )
    if tts_model is None:
        # Uses the default installed TTS model. To change voices/models, see TTS docs.
        tts_model = TTS(list_models()[0], progress_bar=False, gpu=TTS_DEVICE == "cuda")
    return tts_model


def list_models():
    # list available TTS models from coqui (may require internet the first time)
    return TTS.list_models()


@app.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    """Accepts a wav/pcm upload and returns JSON: { "text": "...", "model_response": "..." }
    Also returns a URL to synthesized audio if synthesis was successful.
    """
    contents = await file.read()
    # Attempt to read file with soundfile
    bio = io.BytesIO(contents)
    try:
        data, sr = sf.read(bio)
    except Exception as e:
        return JSONResponse(
            {"error": "could not read audio file", "detail": str(e)}, status_code=400
        )

    # Convert to mono 16-bit float32 array if needed
    if len(data.shape) > 1:
        data = np.mean(data, axis=1)

    model = init_whisper()

    # faster-whisper expects a file path or ndarray
    # We'll use the ndarray path
    segments, info = model.transcribe(data, sample_rate=sr)
    text = "".join([seg.text for seg in segments]).strip()

    # Query local model (text-generation-webui) for a reply
    model_reply = query_model(text)

    # Synthesize reply to WAV bytes
    wav_bytes = None
    try:
        wav_bytes = synthesize_audio(model_reply)
    except Exception as e:
        # return transcript and model reply even if TTS fails
        return {"text": text, "model_response": model_reply, "tts_error": str(e)}

    # Return transcription, reply, and audio as base64 or as streaming endpoint
    return StreamingResponse(
        io.BytesIO(wav_bytes),
        media_type="audio/wav",
        headers={"X-Transcription": text, "X-Model-Response": model_reply},
    )


@app.post("/synthesize")
async def synthesize(body: dict):
    """POST { "text": "..." } -> returns WAV audio bytes"""
    text = body.get("text")
    if not text:
        return JSONResponse({"error": "no text provided"}, status_code=400)
    wav_bytes = synthesize_audio(text)
    return StreamingResponse(io.BytesIO(wav_bytes), media_type="audio/wav")


def query_model(user_text: str) -> str:
    """Try common text-generation-webui API endpoints to get a reply.
    If none respond, return a short fallback message.

    NOTE: text-generation-webui API shapes can vary between versions. If you run a
    different server, edit this function to match your server's API.
    """
    if not user_text:
        return ""

    endpoints = [
        (f"{MODEL_HOST}/api/chat", {"prompt": user_text}),
        (f"{MODEL_HOST}/api/generate", {"prompt": user_text}),
        (f"{MODEL_HOST}/api/v1/generate", {"prompt": user_text}),
    ]

    for url, payload in endpoints:
        try:
            resp = requests.post(url, json=payload, timeout=30)
            if resp.status_code == 200:
                j = resp.json()
                # try some common response shapes
                if isinstance(j, dict):
                    if "response" in j:
                        return j["response"]
                    if (
                        "outputs" in j
                        and isinstance(j["outputs"], list)
                        and len(j["outputs"]) > 0
                    ):
                        o = j["outputs"][0]
                        if isinstance(o, dict) and "text" in o:
                            return o["text"]
                        if isinstance(o, str):
                            return o
                    if "generated_text" in j:
                        return j["generated_text"]
                if isinstance(j, list) and len(j) > 0:
                    first = j[0]
                    if isinstance(first, dict) and "text" in first:
                        return first["text"]
                    if isinstance(first, str):
                        return first
        except Exception:
            continue
    return "(no model response available - check that text-generation-webui is running at http://localhost:7860 and adjust the bridge if necessary)"


def synthesize_audio(text: str) -> bytes:
    """Synthesize text to WAV bytes using Coqui TTS."""
    if not text:
        return b""
    # Initialize TTS lazily
    global tts_model
    if TTS is None:
        raise RuntimeError("TTS package not installed")

    if tts_model is None:
        # Choose a default model. This will download the model the first time you run it.
        # You can replace this with a specific model id e.g. "tts_models/en/vctk/vits"
        available = list_models()
        model_id = available[0] if available else None
        if model_id is None:
            raise RuntimeError(
                "No TTS models available (internet required to download default models the first time)"
            )
        tts_model = TTS(model_id, progress_bar=False, gpu=(TTS_DEVICE == "cuda"))

    wav = tts_model.tts(text)
    # wav is a numpy array (float32). Write to WAV bytes
    bio = io.BytesIO()
    sf.write(bio, wav, tts_model.synthesizer.output_sample_rate, format="WAV")
    return bio.getvalue()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("voice_bridge:app", host="0.0.0.0", port=5005, log_level="info")
