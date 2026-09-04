"""
Model-Aware Routing Engine
==========================
Intelligent backend selection based on model architecture, hardware state, 
and performance requirements.
"""

from typing import Tuple, Dict
import re


class ModelAwareRouter:
    """
    Smart routing engine that selects the optimal inference backend for each request.
    
    Routing Strategy:
    1. MoE models → Hybrid expert routing (vLLM GPU + llama.cpp CPU experts)
    2. Large models on GPU → vLLM for maximum throughput
    3. Modest hardware → llama.cpp with GGUF quantization
    """
    
    # Patterns that indicate MoE architecture
    MOE_MODEL_PATTERNS = [
        r"mixtral", 
        r"deepseek-r1",
        r"moa-",
        r"mixture.*of.*experts",
        r"llama-3\.1-70b-instruct",  # Often deployed as MoE variant
    ]
    
    def __init__(self, hardware_state: dict):
        self.hardware = hardware_state
    
    async def select_backend(self, request_dict: dict) -> Tuple[str, Dict]:
        """
        Select optimal backend based on model type and hardware.
        
        Args:
            request_dict: Parsed inference request (OpenAI-compatible schema)
            
        Returns:
            Tuple of (backend_name, config_dict)
        """
        # Extract model ID from request
        model_id = request_dict.get("model", "default").lower()
        
        # 1. MoE models → hybrid routing strategy
        if any(re.search(pattern, model_id) for pattern in self.MOE_MODEL_PATTERNS):
            return "vllm", {
                "strategy": "hybrid_moE",
                "expert_routing": True,
                "quantization": "fp16"  # MoE needs higher precision for routing accuracy
            }
        
        # 2. Large models (7B+) on GPU → vLLM for throughput
        if self.hardware.get("has_gpu", False) and self.hardware.get("gpu_vram_gb", 0) >= 8:
            return "vllm", {
                "strategy": "gpu_throughput",
                "tensor_parallel": 1,
                "max_model_len": request_dict.get("max_tokens", 2048) * 2
            }
        
        # 3. Modest GPU (4–7GB) → llama.cpp hybrid or vLLM with quantization
        gpu_vram = self.hardware.get("gpu_vram_gb", 0)
        if 4 <= gpu_vram < 8:
            return "llama_cpp", {
                "strategy": "hybrid_cpu_gpu",
                "quantization": "Q5_K_M",
                "n_gpu_layers": int(gpu_vram * 2)
            }
        
        # 4. CPU-only or very modest GPU → llama.cpp with GGUF quantization
        return "llama_cpp", {
            "strategy": "cpu_fallback",
            "quantization": "Q4_K_M",
            "n_ctx": request_dict.get("max_tokens", 2048) * 2,
            "n_threads": min(self.hardware.get("cpu_cores", 1), 8)
        }
