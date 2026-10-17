"""Self-check for cosyvoice3_service's HTTP shape with the model faked, no GPU
or weights needed. Run with the service's python:

    tools/cosyvoice/env/python.exe tools/test_cosyvoice3_service.py
"""

import io
import os
import sys
import tempfile
from unittest import mock

os.environ["COSYVOICE3_TTS_REF_AUDIO"] = "ref.wav"
os.environ["COSYVOICE3_TTS_REF_TEXT"] = "A reference line."
sys.path.insert(0, os.path.dirname(__file__))

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import cosyvoice3_service as svc  # noqa: E402


class FakeTts:
    sample_rate = 24000

    def __init__(self):
        self.spk = []
        self.calls = []

    def add_zero_shot_spk(self, prompt_text, ref_audio, spk_id):
        self.spk.append((prompt_text, ref_audio, spk_id))

    def inference_cross_lingual(self, text, ref_audio, zero_shot_spk_id, stream):
        self.calls.append((text, ref_audio, zero_shot_spk_id, stream))
        if "boom" in text:
            raise RuntimeError("CUDA out of memory")
        yield {"tts_speech": torch.zeros(1, 2400)}
        yield {"tts_speech": torch.ones(1, 1200)}


def run():
    fake = FakeTts()
    svc.model = fake
    client = TestClient(svc.app)
    with mock.patch("torch.cuda.empty_cache") as empty_cache:
        res = client.post("/synthesize", json={"text": "Hello!", "language": "english"})
        assert res.status_code == 200, res.text
        assert res.headers["content-type"] == "audio/wav"
        audio, sample_rate = sf.read(io.BytesIO(res.content))
        assert sample_rate == 24000 and len(audio) == 3600, (sample_rate, len(audio))
        text, ref_audio, spk_id, stream = fake.calls[-1]
        # The prefix goes in front of the text, and the clip is registered once with it in front of its transcript.
        assert text == svc.PREFIX + "Hello!" and ref_audio == "ref.wav" and stream is True
        assert fake.spk == [(svc.PREFIX + "A reference line.", "ref.wav", spk_id)]
        assert empty_cache.call_count == 1

        # The same voice isn't registered again.
        client.post("/synthesize", json={"text": "Hi"})
        assert len(fake.spk) == 1 and fake.calls[-1][2] == spk_id

        # An emotion tag changes the pace: faster means fewer samples.
        res = client.post("/synthesize", json={"text": "Hi", "emotion": "excited"})
        assert len(sf.read(io.BytesIO(res.content))[0]) < 3600

        # A failed generation is a 500 and still frees the cache.
        res = client.post("/synthesize", json={"text": "boom"})
        assert res.status_code == 500 and "out of memory" in res.text
        assert empty_cache.call_count == 4

        assert client.post("/synthesize", json={"text": "  "}).status_code == 400

        # #914: another character's voice, per request, on the same model.
        outside = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        outside.close()
        svc.VOICES_DIR = os.path.realpath(tempfile.mkdtemp())
        with tempfile.NamedTemporaryFile(suffix=".wav", dir=svc.VOICES_DIR, delete=False) as clip:
            pass
        try:
            voice = {"ref_audio": clip.name, "ref_text": "Evil Mana's line."}
            assert client.post("/synthesize", json={"text": "Hi", **voice}).status_code == 200
            assert fake.calls[-1][1] == os.path.realpath(clip.name) and len(fake.spk) == 2
            # Half a voice, or a clip that isn't there, is refused before the model.
            assert client.post("/synthesize", json={"text": "Hi", "ref_audio": clip.name}).status_code == 400
            missing = {"ref_audio": clip.name + ".gone", "ref_text": "x"}
            assert client.post("/synthesize", json={"text": "Hi", **missing}).status_code == 400
            # Only clips under node-bot/data, never any file the caller names.
            elsewhere = {"ref_audio": outside.name, "ref_text": "x"}
            assert client.post("/synthesize", json={"text": "Hi", **elsewhere}).status_code == 400
        finally:
            os.remove(clip.name)
            os.remove(outside.name)

    health = client.get("/health").json()
    assert health["ok"] is True and health["ref_audio"] == "ref.wav", health
    print("ok")


if __name__ == "__main__":
    run()
