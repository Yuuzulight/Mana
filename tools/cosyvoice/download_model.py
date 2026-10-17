# Fetches Fun-CosyVoice3-0.5B-2512 for Mana's CosyVoice3 voice (docs/cosyvoice3_tts.md), without the
# TensorRT-only files (batch tokenizer, fp32 flow estimator) and the RL checkpoint it doesn't load.
import os
from huggingface_hub import snapshot_download

here = os.path.dirname(os.path.abspath(__file__))
path = snapshot_download(
    "FunAudioLLM/Fun-CosyVoice3-0.5B-2512",
    local_dir=os.path.join(here, "models", "Fun-CosyVoice3-0.5B-2512"),
    ignore_patterns=["*.batch.onnx", "flow.decoder.estimator.fp32.onnx", "asset/*", "*.md", "llm.rl.pt"],
)
print("done", path)
