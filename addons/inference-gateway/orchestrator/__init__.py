"""
Mana Inference Gateway Orchestrator
==================================
Hardware-aware inference routing combining vLLM (GPU prod), llama.cpp (CPU/edge), 
and Colibri (MoE optimization) behind a unified OpenAI-compatible API.

Dual-tier architecture:
- Plugins: Auto-approved minor features
- Add-ons: Consent-required full-scale features (this module)
"""

from .core import ManaOrchestrator, InferenceRequest, HardwareState
from .hardware import detect_hardware, GPUResourcePool, CPUResourcePool
from .routing import ModelAwareRouter, MOE_MODEL_PATTERNS
from .backends.vllm_wrapper import VLLMBackend
from .backends.llama_cpp_wrapper import LlamaCPPBackend

__version__ = "0.1.0"
__all__ = [
    "ManaOrchestrator",
    "InferenceRequest",
    "HardwareState",
    "detect_hardware",
    "GPUResourcePool",
    "CPUResourcePool",
    "ModelAwareRouter",
    "MOE_MODEL_PATTERNS",
    "VLLMBackend",
    "LlamaCPPBackend",
]
