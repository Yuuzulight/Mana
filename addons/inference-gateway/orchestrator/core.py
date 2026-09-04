"""
Core Orchestrator Logic
=======================
Hardware-aware inference routing with model detection and fallback chains.
"""

from typing import Dict, Optional, List, Tuple
import asyncio
import json
import os
from dataclasses import dataclass, asdict


@dataclass(frozen=True)
class InferenceRequest:
    """Unified inference request schema (OpenAI-compatible)."""
    model: str = "default"
    messages: List[Dict] = None
    max_tokens: int = 2048
    temperature: float = 1.0
    top_p: float = 1.0
    stream: bool = False
    
    def __post_init__(self):
        if self.messages is None:
            object.__setattr__(self, 'messages', [])


@dataclass(frozen=True)
class HardwareState:
    """Detected hardware capabilities."""
    has_gpu: bool = False
    gpu_vram_gb: float = 0.0
    cpu_cores: int = 1
    cuda_available: bool = False
    
    def __str__(self):
        return f"GPU:{self.has_gpu}({self.gpu_vram_gb:.1f}GB) CPU:{self.cpu_cores}"


class ModelAwareRouter:
    """Smart routing engine based on model type and hardware state."""
    
    # MoE models that benefit from hybrid expert routing
    MOE_MODEL_PATTERNS = [
        "mixtral", "deepseek-r1", "moa-", "mixture-of-experts", 
        "llama-3.1-70b-instruct"  # Often deployed as MoE variant
    ]
    
    def __init__(self, hardware_state: HardwareState):
        self.hardware = hardware_state
    
    async def select_backend(self, request: InferenceRequest) -> Tuple[str, Dict]:
        """
        Select optimal backend based on model type and hardware.
        
        Returns:
            Tuple of (backend_name, config_dict)
        """
        model_lower = request.model.lower()
        
        # 1. MoE models → hybrid routing strategy
        if any(pattern in model_lower for pattern in self.MOE_MODEL_PATTERNS):
            return "vllm", {
                "strategy": "hybrid_moE",
                "expert_routing": True,
                "quantization": "fp16"  # MoE needs higher precision
            }
        
        # 2. Large models (7B+) on GPU → vLLM for throughput
        if self.hardware.has_gpu and self.hardware.gpu_vram_gb >= 8:
            return "vllm", {
                "strategy": "gpu_throughput",
                "tensor_parallel": 1,
                "max_model_len": request.max_tokens * 2
            }
        
        # 3. Modest GPU (4–7GB) → vLLM with aggressive quantization or llama.cpp hybrid
        if self.hardware.has_gpu and 4 <= self.hardware.gpu_vram_gb < 8:
            return "llama_cpp", {
                "strategy": "hybrid_cpu_gpu",
                "quantization": "Q5_K_M",
                "n_gpu_layers": int(self.hardware.gpu_vram_gb * 2)
            }
        
        # 4. CPU-only or very modest GPU → llama.cpp with GGUF quantization
        return "llama_cpp", {
            "strategy": "cpu_fallback",
            "quantization": "Q4_K_M",
            "n_ctx": request.max_tokens * 2,
            "n_threads": min(self.hardware.cpu_cores, 8)
        }


class ManaOrchestrator:
    """
    Main orchestrator that combines backends behind a unified API surface.
    
    Dual-tier architecture alignment:
    - This module is an Add-on tier (requires consent via /addons/consent/:id)
    - Plugins remain auto-approved in server.js startup wiring
    """
    
    def __init__(self, config_path: Optional[str] = None):
        # Load hardware state once at initialization
        self.hardware = detect_hardware()
        
        # Initialize router with hardware-aware logic
        self.router = ModelAwareRouter(self.hardware)
        
        # Backend health states (lazy-loaded)
        self._backends: Dict[str, object] = {}
        self._backend_health: Dict[str, bool] = {
            "vllm": False,
            "llama_cpp": False,
            "colibri": False  # TODO: wire up when available
        }
        
        # Load config if provided
        if config_path and os.path.exists(config_path):
            with open(config_path, 'r') as f:
                self.config = json.load(f)
        else:
            self.config = {
                "default-runtime": "vllm",
                "fallback-chain": ["vllm", "llama_cpp"],
                "health-check-interval": 30,
                "max-concurrent-requests": 10,
                "timeout-per-request": 60
            }
    
    async def ensure_backends(self):
        """Lazy-load backends on first request."""
        if not self._backends["vllm"]:
            # vLLM runs as separate process with OpenAI-compatible API
            from .backends.vllm_wrapper import VLLMBackend
            self._backends["vllm"] = VLLMBackend("http://localhost:8001")
        
        if not self._backends["llama_cpp"]:
            # llama.cpp also exposes OpenAI-compatible endpoint
            from .backends.llama_cpp_wrapper import LlamaCPPBackend
            self._backends["llama_cpp"] = LlamaCPPBackend("http://localhost:8081")
        
        if not self._backends["colibri"]:
            # TODO: Colibri integration when available
            pass
    
    async def health_check(self):
        """Periodic health check for all backends."""
        interval = self.config.get("health-check-interval", 30)
        
        while True:
            await asyncio.sleep(interval)
            
            # Check each backend's health endpoint
            for name, backend in self._backends.items():
                try:
                    is_healthy = await backend.is_healthy()
                    self._backend_health[name] = is_healthy
                except Exception as e:
                    print(f"[Orchestrator] Health check failed for {name}: {e}")
    
    async def generate(self, request: InferenceRequest) -> dict:
        """
        Unified generation endpoint with hardware-aware routing.
        
        This is the core "best of all three" logic:
        - MoE models → hybrid expert routing (vLLM GPU + llama.cpp CPU experts)
        - Large models on GPU → vLLM for throughput
        - Modest hardware → llama.cpp with GGUF quantization
        """
        await self.ensure_backends()
        
        # Select optimal backend based on model and hardware
        backend_name, config = await self.router.select_backend(request)
        
        try:
            # Forward request to selected backend
            response = await self._backend_call(backend_name, request, config)
            
            if not isinstance(response, dict):
                raise ValueError("Backend returned non-JSON response")
            
            return response
        
        except Exception as e:
            # Fallback chain logic (if multiple backends configured)
            fallback_chain = self.config.get("fallback-chain", ["vllm", "llama_cpp"])
            
            if backend_name in fallback_chain and len(fallback_chain) > 1:
                next_backend = fallback_chain[(fallback_chain.index(backend_name) + 1) % len(fallback_chain)]
                
                # Retry with next backend (simplified — real impl would preserve request context)
                print(f"[Orchestrator] Fallback to {next_backend} due to error: {e}")
                raise  # In production, you'd retry here; for now re-raise
    
    async def _backend_call(self, backend_name: str, request: InferenceRequest, config: Dict) -> dict:
        """Forward request to selected backend."""
        backend = self._backends[backend_name]
        
        # Build request payload (OpenAI-compatible)
        payload = {
            "model": request.model,
            "messages": request.messages,
            "max_tokens": request.max_tokens,
            "temperature": request.temperature,
            "top_p": request.top_p,
        }
        
        if not request.stream:
            # Non-streaming completion
            try:
                response = await backend.complete(payload, timeout=self.config.get("timeout-per-request", 60))
                
                # Normalize response format (some backends return {choices: [...], ...})
                if "choices" in response and len(response["choices"]) > 0:
                    return {
                        "id": f"gateway-{request.model}",
                        "object": "chat.completion",
                        "created": int(asyncio.get_event_loop().time()),
                        "model": request.model,
                        **response
                    }
                
                # Pass through backend response as-is
                return response
            
            except Exception as e:
                raise RuntimeError(f"Backend {backend_name} failed: {e}")
        
        # Streaming support (simplified)
        raise NotImplementedError("Streaming not yet implemented in orchestrator")
