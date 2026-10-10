# #1454: the flow's estimator (CosyVoice2's causal U-Net decoder, CosyVoice3's DiT) as CUDA graphs. Its solver calls
# it once a step, 10 steps a chunk, with the same shapes every time, and the first chunk's shapes are the same every
# request (same prompt, same chunk size), so one graph a shape replays nearly every call. A shape that won't capture
# runs as before. Captured thread-local: the LM thread keeps syncing its own stream while the flow captures.
import contextlib
from collections import OrderedDict
import threading
import torch

# Held while a graph is captured: a device-wide call (torch.cuda.synchronize) from another thread during a capture is an
# error, so code that makes one takes this first.
capture_lock = threading.Lock()


def autocast_uncached():
    """The caller's autocast, with its weight-cast cache off: a cast cached during a capture is freed after it, and the
    graph would then read freed memory on replay (the TTS runs the flow under fp16 autocast)."""
    if not torch.is_autocast_enabled():
        return contextlib.nullcontext()
    return torch.autocast("cuda", dtype=torch.get_autocast_gpu_dtype(), cache_enabled=False)


class GraphedEstimator:
    def __init__(self, estimator, max_graphs=8):
        self.estimator = estimator
        self.max_graphs = max_graphs
        self.graphs = OrderedDict()       # (shapes, dtype, streaming) -> (graph, static inputs, static output)
        self.eager = set()                # shapes that wouldn't capture

    def __call__(self, x, mask, mu, t, spks, cond, streaming=False):
        args = (x, mask, mu, t, spks, cond)
        if not x.is_cuda:
            return self.estimator(*args, streaming=streaming)
        key = (tuple(tuple(a.shape) for a in args), x.dtype, streaming)
        if key in self.eager:
            return self.estimator(*args, streaming=streaming)
        entry = self.graphs.get(key)
        if entry is None:
            entry = self._capture(key, args, streaming)
            if entry is None:
                return self.estimator(*args, streaming=streaming)
        else:
            self.graphs.move_to_end(key)
        graph, static, out = entry
        for s, a in zip(static, args):
            s.copy_(a)
        graph.replay()
        return out.clone()

    @torch.inference_mode()
    def _capture(self, key, args, streaming):
        try:
            with capture_lock, autocast_uncached():
                static = [a.clone() for a in args]
                side = torch.cuda.Stream()
                side.wait_stream(torch.cuda.current_stream())
                with torch.cuda.stream(side):
                    for _ in range(2):
                        self.estimator(*static, streaming=streaming)
                torch.cuda.current_stream().wait_stream(side)
                graph = torch.cuda.CUDAGraph()
                with torch.cuda.graph(graph, capture_error_mode="thread_local"):
                    out = self.estimator(*static, streaming=streaming)
        except Exception as e:
            import sys, traceback
            print(f"flow graph capture failed for {key[0]}: {e!r}", file=sys.stderr, flush=True)
            traceback.print_exc()
            self.eager.add(key)
            return None
        if len(self.graphs) >= self.max_graphs:
            self.graphs.popitem(last=False)
        self.graphs[key] = entry = (graph, static, out)
        return entry


def chunk_mask_without_sync(xs, masks, use_dynamic_chunk, use_dynamic_left_chunk, decoding_chunk_size, static_chunk_size,
                            num_decoding_left_chunks, enable_full_context=True):
    """CosyVoice's add_optional_chunk_mask for the DiT's calls (no dynamic chunks), without its host sync.

    The original ends with `.item()` on a check that sets all-false rows to true; a sync can't be captured in a graph.
    Setting such rows true is done with a mask here, so the result is the same and no value leaves the GPU.
    """
    from cosyvoice.utils.mask import subsequent_chunk_mask
    assert not use_dynamic_chunk, "the DiT never uses dynamic chunks"
    chunk_masks = masks
    if static_chunk_size > 0:
        chunk = subsequent_chunk_mask(xs.size(1), static_chunk_size, num_decoding_left_chunks, xs.device).unsqueeze(0)
        chunk_masks = masks & chunk
    empty = chunk_masks.sum(dim=-1) == 0
    return chunk_masks | empty.unsqueeze(-1)


def enable(flow):
    """Routes flow.decoder's estimator calls through GraphedEstimator; a TensorRT estimator is left alone."""
    decoder = flow.decoder
    if not isinstance(decoder.estimator, torch.nn.Module) or not torch.cuda.is_available():
        return None
    # CosyVoice3's DiT and CosyVoice2's causal decoder both take the chunk mask with a host sync (see
    # chunk_mask_without_sync). Patched for the graph's sake only; the results are the same.
    for module in ("cosyvoice.flow.DiT.dit", "cosyvoice.flow.decoder"):
        try:
            import importlib
            importlib.import_module(module).add_optional_chunk_mask = chunk_mask_without_sync
        except ImportError:
            pass
    graphed = GraphedEstimator(decoder.estimator)
    forward = decoder.forward_estimator

    def forward_estimator(x, mask, mu, t, spks, cond, streaming=False):
        return graphed(x, mask, mu, t, spks, cond, streaming)
    decoder.forward_estimator = forward_estimator
    decoder.forward_estimator_eager = forward
    return graphed
