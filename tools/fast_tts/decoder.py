# #1454: the autoregressive part of a token-based TTS model, fast on Windows: a Hugging Face decoder-only backbone
# (Qwen2/2.5/3, Llama, ...) on a fixed-size KV cache, one decode step captured as a CUDA graph and replayed per token.
# What vLLM gives these models on Linux, without vLLM.
import numpy as np
import torch
from transformers import StaticCache


class GraphDecoder:
    """backbone: the decoder taking inputs_embeds / cache_position / past_key_values (e.g. Qwen2Model).
    head: hidden state (1, H) -> logits (1, V). embed: the nn.Embedding for the tokens it generates.
    prefill() and step() give the next token's probabilities as a NumPy array (one copy a token)."""

    def __init__(self, backbone, head, embed, max_cache_len=4096, dtype=torch.bfloat16, device="cuda"):
        self.backbone, self.head, self.embed = backbone, head, embed
        self.max_cache_len, self.dtype, self.device = max_cache_len, dtype, device
        config = backbone.config
        self.cache = StaticCache(config=config, max_batch_size=1, max_cache_len=max_cache_len, device=device, dtype=dtype)
        self.emb = torch.zeros(1, 1, config.hidden_size, device=device, dtype=dtype)
        self.pos = torch.zeros(1, dtype=torch.long, device=device)
        self.graph, self.probs, self.pinned = None, None, None

    def _forward(self, embeds, positions):
        h = self.backbone(inputs_embeds=embeds, cache_position=positions, past_key_values=self.cache, use_cache=True).last_hidden_state
        return self.head(h[:, -1]).float().softmax(dim=-1)[0]

    def _host(self, probs):
        if self.pinned is None:
            self.pinned = torch.empty(probs.shape[0], dtype=torch.float32, pin_memory=True)
        self.pinned.copy_(probs, non_blocking=True)
        torch.cuda.current_stream().synchronize()
        return self.pinned.numpy().astype(np.float64)

    @torch.inference_mode()
    def prefill(self, embeds):
        """The prompt's embeddings (1, T, H); returns (probabilities, the next position)."""
        self.cache.reset()
        n = embeds.shape[1]
        if n >= self.max_cache_len:
            raise ValueError(f"a {n}-token prompt doesn't fit the {self.max_cache_len}-token cache")
        return self._host(self._forward(embeds.to(self.device, self.dtype), torch.arange(n, device=self.device))), n

    @torch.inference_mode()
    def step(self, token, position):
        """The token just chosen, at position; returns the next token's probabilities."""
        self.emb.copy_(self.embed.weight[token].reshape(1, 1, -1))
        self.pos.fill_(position)
        if self.graph is None:
            side = torch.cuda.Stream()
            side.wait_stream(torch.cuda.current_stream())
            with torch.cuda.stream(side):
                for _ in range(3):   # warm-up; writes only the slot the real step writes next
                    self._forward(self.emb, self.pos)
            torch.cuda.current_stream().wait_stream(side)
            self.graph = torch.cuda.CUDAGraph()
            with torch.cuda.graph(self.graph):
                self.probs = self._forward(self.emb, self.pos)
        self.graph.replay()
        return self._host(self.probs)


def generate(decoder, sampler, prompt_embeds, max_len, stop_ids, min_len=0):
    """Yields tokens until a stop token, max_len, or the cache is full."""
    probs, position = decoder.prefill(prompt_embeds)
    out = []
    for i in range(min(max_len, decoder.max_cache_len - position)):
        token = sampler(probs, out, mask_eos=i < min_len)
        if token in stop_ids:
            return
        yield token
        out.append(token)
        probs = decoder.step(token, position)
        position += 1
