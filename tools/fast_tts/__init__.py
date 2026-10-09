# #1454: Mana's own fast inference runtime for token-based TTS models on Windows. See decoder.py, sampling.py and the
# per-model adapters (cosyvoice.py).
from .decoder import GraphDecoder, generate
from .sampling import CpuSampler
