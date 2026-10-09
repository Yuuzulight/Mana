# #1454: the flow's estimator (CosyVoice2's causal U-Net decoder, CosyVoice3's DiT) as CUDA graphs. Its solver calls
# it once a step, 10 steps a chunk, with the same shapes every time, and the first chunk's shapes are the same every
# request (same prompt, same chunk size), so one graph a shape replays nearly every call. A shape that won't capture
# runs as before.
from collections import OrderedDict
import torch


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
            static = [a.clone() for a in args]
            side = torch.cuda.Stream()
            side.wait_stream(torch.cuda.current_stream())
            with torch.cuda.stream(side):
                for _ in range(2):
                    self.estimator(*static, streaming=streaming)
            torch.cuda.current_stream().wait_stream(side)
            graph = torch.cuda.CUDAGraph()
            with torch.cuda.graph(graph):
                out = self.estimator(*static, streaming=streaming)
        except Exception:
            self.eager.add(key)
            return None
        if len(self.graphs) >= self.max_graphs:
            self.graphs.popitem(last=False)
        self.graphs[key] = entry = (graph, static, out)
        return entry


def enable(flow):
    """Routes flow.decoder's estimator calls through GraphedEstimator; a TensorRT estimator is left alone."""
    decoder = flow.decoder
    if not isinstance(decoder.estimator, torch.nn.Module) or not torch.cuda.is_available():
        return None
    graphed = GraphedEstimator(decoder.estimator)
    forward = decoder.forward_estimator

    def forward_estimator(x, mask, mu, t, spks, cond, streaming=False):
        return graphed(x, mask, mu, t, spks, cond, streaming)
    decoder.forward_estimator = forward_estimator
    decoder.forward_estimator_eager = forward
    return graphed
