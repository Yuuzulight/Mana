# #1454: token sampling for audio-token models on the CPU, from one copy of the probabilities a token, instead of a
# chain of small GPU kernels and syncs. Nucleus (top-k + top-p), optional temperature, a masked end token while the
# reply is still too short, and CosyVoice's repetition-aware fallback (RAS): a token repeated within the last window
# is masked and the whole distribution sampled instead.
import numpy as np


class CpuSampler:
    def __init__(self, top_k=25, top_p=0.8, temperature=1.0, eos=None, win_size=0, tau_r=0.1, seed=None):
        self.top_k, self.top_p, self.temperature = top_k, top_p, temperature
        self.eos, self.win, self.tau = eos, win_size, tau_r
        self.rng = np.random.default_rng(seed)

    def _prepare(self, p, mask_eos):
        if self.temperature != 1.0:
            p = np.power(p, 1.0 / self.temperature)
        if mask_eos and self.eos is not None:   # a -inf score before the softmax: drop it and renormalise
            p = p.copy(); p[self.eos] = 0.0
        return p / p.sum()

    def candidates(self, p, mask_eos=False):
        """The tokens nucleus sampling chooses among and their weights: the most likely first, kept while the
        probability before each is under top_p and there are fewer than top_k."""
        p = self._prepare(p, mask_eos)
        order = np.argsort(-p, kind="stable")[: self.top_k]
        top = p[order]
        keep = (np.cumsum(top) - top) < self.top_p
        return order[keep], top[keep], p

    def __call__(self, p, decoded, mask_eos=False):
        cand, w, p = self.candidates(p, mask_eos)
        token = int(cand[self.rng.choice(len(cand), p=w / w.sum())])
        if self.win and decoded[-self.win:].count(token) >= self.win * self.tau:
            q = p.copy(); q[token] = 0.0
            token = int(self.rng.choice(len(q), p=q / q.sum()))
        return token
