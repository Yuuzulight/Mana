"""
vLLM Backend Wrapper
====================
Thin HTTP client wrapper around vLLM's OpenAI-compatible API endpoint.
No subprocess management — assumes vLLM is running as a separate process.
"""

import httpx
from typing import Dict, Any


class VLLMBackend:
    """
    vLLM backend integration via HTTP.
    
    Assumes vLLM is already running with OpenAI-compatible API exposed.
    Health checks and timeouts are handled at orchestrator level.
    """
    
    def __init__(self, base_url: str = "http://localhost:8001"):
        self.base_url = base_url.rstrip("/")
        self._client: httpx.AsyncClient = None
    
    async def _get_client(self) -> httpx.AsyncClient:
        """Lazy HTTP client initialization."""
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                timeout=httpx.Timeout(60.0, connect=10.0)
            )
        return self._client
    
    async def is_healthy(self) -> bool:
        """Check if vLLM backend is responding."""
        try:
            async with self._get_client() as client:
                response = await client.get(f"{self.base_url}/v1/models")
                return response.status_code == 200
        except Exception:
            return False
    
    async def complete(self, payload: Dict[str, Any], timeout: float = 60.0) -> Dict[str, Any]:
        """
        Generate completion using vLLM backend.
        
        Args:
            payload: OpenAI-compatible request dict
            timeout: Maximum time to wait for response
            
        Returns:
            Normalized completion response
        """
        async with self._get_client() as client:
            response = await client.post(
                f"{self.base_url}/v1/chat/completions",
                json=payload,
                timeout=timeout
            )
            
            if not response.is_success:
                raise RuntimeError(f"vLLM API error {response.status_code}: {response.text}")
            
            return response.json()
