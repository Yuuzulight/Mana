import sys
from pathlib import Path
from typing import Optional, AsyncGenerator
import asyncio
import signal
import struct
import wave
import numpy as np
from fastapi import FastAPI, File, UploadFile, HTTPException
from pydantic import BaseModel

# Minimal Whisper transcriber (CPU-only, no GPU overhead)
class MiniWhisper:
    def __init__(self):
        self.model = None  # Lazy-load or use a tiny model like whisper-tiny
        self.device = "cpu"

    async def transcribe(self, wav_bytes: bytes) -> str:
        if not hasattr(self, 'model') or self.model is None:
            raise RuntimeError("MiniWhisper not initialized. Call load() first.")
        
        # Decode WAV to numpy array (16kHz mono 16-bit)
        audio_data = np.frombuffer(wav_bytes, dtype=np.int16)
        samples = audio_data.astype(np.float32) / 32768.0
        
        # In production: self.model.transcribe(samples)
        # For now, return a placeholder to verify the pipeline works
        return "mini-whisper-placeholder-transcript"

# Minimal local LLM reply generator (CPU-only)
class MiniLLM:
    def __init__(self):
        self.model = None  # Lazy-load GGUF via llama.cpp or similar
    
    async def generate_reply(self, text: str) -> str:
        if not hasattr(self, 'model') or self.model is None:
            raise RuntimeError("MiniLLM not initialized. Call load() first.")
        
        # In production: self.model.generate(prompt=text)
        # For now, return a placeholder to verify the pipeline works
        return f"mini-llm-reply-to-{text}"

# Minimal TTS synthesizer (CPU-only, no GPU overhead)
class MiniTTS:
    def __init__(self):
        self.model = None  # Lazy-load or use a tiny model
    
    async def synthesize(self, text: str) -> bytes:
        if not hasattr(self, 'model') or self.model is None:
            raise RuntimeError("MiniTTS not initialized. Call load() first.")
        
        # In production: self.model.generate(text) → WAV bytes (16kHz mono 16-bit)
        # For now, generate a simple sine wave test tone as WAV
        return await self._generate_test_tone_wav(text)

    async def _generate_test_tone_wav(self, text: str) -> bytes:
        """Generate a simple 440Hz sine wave WAV file (16kHz mono 16-bit)."""
        sample_rate = 16000
        duration = len(text) / 5.0  # ~0.2s per character
        frequency = 440.0
        
        num_samples = int(sample_rate * duration)
        t = np.linspace(0, duration, num_samples, endpoint=False)
        samples = (np.sin(2 * np.pi * frequency * t)).astype(np.int16)
        
        # Create WAV file in memory
        wav_buffer = io.BytesIO()
        with wave.open(wav_buffer, 'wb') as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)  # 16-bit
            wav_file.setframerate(sample_rate)
            for sample in samples:
                wav_file.writeframes(struct.pack('<h', sample))
        
        return wav_buffer.getvalue()

# Global instances (lazy-loaded on first use)
mini_whisper = MiniWhisper()
mini_llm = MiniLLM()
mini_tts = MiniTTS()

app = FastAPI(title="Mana Backend API", version="1.0.0")

@app.on_event("startup")
async def startup():
    # Initialize models here (lazy-load GGUF, Whisper, etc.)
    print("[Backend] Startup complete")

@app.on_event("shutdown")
async def shutdown():
    # Cleanup resources here
    print("[Backend] Shutting down")

@app.get("/perf/status", response_model=ManaPerformanceStatus)
def get_performance_status() -> ManaPerformanceStatus:
    """Return current memory/performance metrics."""
    import resource
    mem_rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss  # KB on Linux, bytes on macOS/Windows
    return ManaPerformanceStatus(
        totalMemoryMb=max(int(mem_rss / 1024), 1),  # Convert to MB
        ttsProvider="mini-tts-cpu",
        gamingAppRunning=False
    )

@app.post("/transcribe-only")
async def transcribe_only(file: UploadFile = File(...)):
    """Transcribe audio file using Whisper."""
    if not file.content_type.startswith("audio/"):
        raise HTTPException(status_code=400, detail="Invalid content type. Expected audio/wav.")
    
    wav_bytes = await file.read()
    transcript = await mini_whisper.transcribe(wav_bytes)
    return {"transcript": transcript}

@app.post("/reply")
async def reply(text: str):
    """Generate a reply using the local LLM."""
    if not text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty.")
    
    reply = await mini_llm.generate_reply(text)
    return {"reply": reply}

@app.post("/synthesize")
async def synthesize(text: str):
    """Synthesize speech from text using local TTS."""
    if not text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty.")
    
    wav_bytes = await mini_tts.synthesize(text)
    return {"audio": wav_bytes}

# Graceful shutdown handler
def signal_handler(sig, frame):
    print(f"\n[Backend] Received signal {sig}, shutting down gracefully...")
    sys.exit(0)

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

if __name__ == "__main__":
    import uvicorn
    
    # Run with minimal worker count for low memory footprint
    uvicorn.run(app, host="127.0.0.1", port=5005, workers=1, log_level="info")
