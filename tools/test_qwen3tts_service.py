"""Self-check for qwen3tts_service's HTTP shape (#891) with the model faked, no
GPU or weights needed. Run with the service's venv:

    tools/qwen3-tts/.venv/Scripts/python.exe tools/test_qwen3tts_service.py
"""

import io
import os
import sys
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import qwen3tts_service as svc  # noqa: E402


class FakeTts:
    def __init__(self):
        self.calls = []

    def generate_voice_clone(self, **kwargs):
        self.calls.append(kwargs)
        if kwargs["text"] == "boom":
            raise RuntimeError("CUDA out of memory")
        return [np.zeros(2400, dtype=np.float32), np.ones(1200, dtype=np.float32)], 24000


def run():
    fake = FakeTts()
    svc.model = fake
    client = TestClient(svc.app)
    with mock.patch("torch.cuda.empty_cache") as empty_cache:
        res = client.post("/synthesize", json={"text": "Hello!", "language": "japanese"})
        assert res.status_code == 200, res.text
        assert res.headers["content-type"] == "audio/wav"
        audio, sample_rate = sf.read(io.BytesIO(res.content))
        assert sample_rate == 24000 and len(audio) == 3600, (sample_rate, len(audio))
        call = fake.calls[-1]
        assert call["language"] == "japanese" and call["text"] == "Hello!"
        assert call["ref_audio"] == svc.REF_AUDIO and call["ref_text"] == svc.REF_TEXT
        assert empty_cache.call_count == 1

        # No hint -> the model's own detection.
        client.post("/synthesize", json={"text": "Hi"})
        assert fake.calls[-1]["language"] == "auto"

        # A failed generation is a 500 and still frees the cache.
        res = client.post("/synthesize", json={"text": "boom"})
        assert res.status_code == 500 and "out of memory" in res.text
        assert empty_cache.call_count == 3

        assert client.post("/synthesize", json={"text": "  "}).status_code == 400
        assert len(fake.calls) == 3

        # #909: an emotion tag changes the pace (sad slower, excited faster)
        # and never reaches the model; an unknown one changes nothing.
        def samples(emotion):
            res = client.post("/synthesize", json={"text": "Hi", "emotion": emotion})
            assert res.status_code == 200 and "emotion" not in fake.calls[-1], res.text
            return len(sf.read(io.BytesIO(res.content))[0])

        assert samples("sad") == round(3600 / 0.93)
        assert samples("excited") == round(3600 / 1.07)
        assert samples("sparkly") == samples(None) == 3600

    assert client.get("/health").json()["ok"] is True
    # #904: a real call on this process, so the ctypes signatures are
    # checked too (nothing to trim off Windows).
    assert svc.trim_working_set() is (os.name == "nt")
    print("qwen3tts_service self-check passed")


if __name__ == "__main__":
    run()
