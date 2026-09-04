"""
Hardware Detection & Resource Pooling
=====================================
Detects available hardware (GPU VRAM, CPU cores) and manages resource pools 
for hybrid inference scheduling across vLLM, llama.cpp, and Colibri backends.
"""

import asyncio
import subprocess
from typing import Optional


class GPUResourcePool:
    """Manages GPU VRAM allocation across inference backends."""
    
    def __init__(self, max_vram_gb: float = 16.0):
        self.max_vram_gb = max_vram_gb
        self._allocated_vram_gb = 0.0
    
    async def has_available_vram(self, required_gb: float) -> bool:
        """Check if sufficient VRAM is available for a new model."""
        return (self.max_vram_gb - self._allocated_vram_gb) >= required_gb
    
    async def allocate(self, vram_gb: float) -> bool:
        """Allocate VRAM for a new inference session."""
        if await self.has_available_vram(vram_gb):
            self._allocated_vram_gb += vram_gb
            return True
        return False
    
    async def deallocate(self, vram_gb: float):
        """Release VRAM after inference completion."""
        self._allocated_vram_gb = max(0.0, self._allocated_vram_gb - vram_gb)


class CPUResourcePool:
    """Manages CPU core allocation for hybrid expert routing."""
    
    def __init__(self, cores: int = 8):
        self.cores = cores
    
    async def get_available_cores(self) -> int:
        """Get number of available CPU cores (simplified — real impl would check load)."""
        return min(self.cores, 4)  # Reserve some cores for system tasks


async def detect_hardware() -> dict:
    """
    Detect available hardware capabilities.
    
    Returns:
        Dict with has_gpu, gpu_vram_gb, cpu_cores, cuda_available
    """
    result = {
        "has_gpu": False,
        "gpu_vram_gb": 0.0,
        "cpu_cores": 1,
        "cuda_available": False
    }
    
    # Detect GPU and VRAM via nvidia-smi (Windows/Mac/Linux compatible)
    try:
        proc = await asyncio.create_subprocess_exec(
            "nvidia-smi", "--query-gpu=memory.total,name", 
            "--format=csv,noheader",
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
        )
        output = await proc.communicate()
        
        if output:
            lines = output.decode().strip().split('\n')
            for line in lines:
                parts = line.split(',')
                if len(parts) >= 2:
                    vram_str, gpu_name = parts[0].strip(), parts[1].strip()
                    
                    # Parse VRAM (e.g., "4GiB" → 4.0)
                    try:
                        vram_gb = float(vram_str.replace('G', '').replace('i', ''))
                        
                        if vram_gb > result["gpu_vram_gb"]:
                            result["has_gpu"] = True
                            result["gpu_vram_gb"] = vram_gb
                    
                    except ValueError:
                        pass
            
            # Check CUDA availability via nvcc or cuda-check
            try:
                proc = await asyncio.create_subprocess_exec(
                    "nvcc", "--version", stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
                )
                await proc.communicate()
                result["cuda_available"] = True
                
            except FileNotFoundError:
                pass  # CUDA not installed or not in PATH
        
    except Exception as e:
        print(f"[Hardware Detection] nvidia-smi failed: {e}")
    
    # Detect CPU cores (cross-platform)
    try:
        import os
        result["cpu_cores"] = max(1, os.cpu_count() or 1)
        
    except Exception:
        pass
    
    return result
