"""Self-check for tools/fast_tts (#1454). The sampler needs only NumPy; the decoder check needs CUDA, PyTorch and
transformers and is skipped without them. Run with the CosyVoice venv (or any with those):

    tools/cosyvoice/env/python.exe tools/test_fast_tts.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

import numpy as np  # noqa: E402

from fast_tts.sampling import CpuSampler  # noqa: E402


def upstream_nucleus(p, top_p=0.8, top_k=25):
    # CosyVoice's nucleus_sampling loop (cosyvoice/utils/common.py), the candidate set it chooses from.
    order = np.argsort(-p, kind="stable")
    kept, cum = [], 0.0
    for i in order:
        if cum < top_p and len(kept) < top_k:
            cum += p[i]
            kept.append(int(i))
        else:
            break
    return kept


def check_sampler_matches_upstream():
    rng = np.random.default_rng(0)
    s = CpuSampler(top_k=25, top_p=0.8, eos=7)
    for trial in range(300):
        logits = rng.normal(scale=rng.uniform(0.5, 6), size=300)
        p = np.exp(logits) / np.exp(logits).sum()
        cand, _, _ = s.candidates(p)
        assert list(cand) == upstream_nucleus(p), trial
        masked = p.copy(); masked[7] = 0; masked /= masked.sum()
        cand, _, _ = s.candidates(p, mask_eos=True)
        assert list(cand) == upstream_nucleus(masked) and 7 not in cand, trial


def check_repetition_fallback():
    s = CpuSampler(top_k=1, top_p=0.8, win_size=10, tau_r=0.1, seed=1)
    p = np.full(50, 0.001); p[3] = 1.0; p /= p.sum()
    assert s(p, decoded=[]) == 3                          # top-1 is token 3
    assert all(s(p, decoded=[3]) != 3 for _ in range(50))  # a repeat in the window: sampled from the rest


def check_decoder_matches_plain_forward():
    try:
        import torch
        from transformers import Qwen2Config, Qwen2Model
    except ImportError:
        print("decoder: skipped (no torch/transformers)")
        return
    if not torch.cuda.is_available():
        print("decoder: skipped (no CUDA)")
        return
    from fast_tts.decoder import GraphDecoder
    torch.manual_seed(0)
    cfg = Qwen2Config(hidden_size=64, intermediate_size=128, num_hidden_layers=2, num_attention_heads=4,
                      num_key_value_heads=2, vocab_size=10, max_position_embeddings=256)
    backbone = Qwen2Model(cfg).cuda().float().eval()
    head = torch.nn.Linear(64, 40, bias=False).cuda().float()
    embed = torch.nn.Embedding(40, 64).cuda().float()
    dec = GraphDecoder(backbone, head, embed, max_cache_len=128, dtype=torch.float32)

    def plain(embeds):
        with torch.inference_mode():
            return head(backbone(inputs_embeds=embeds).last_hidden_state[:, -1]).softmax(-1)[0].cpu().numpy()

    for prompt_len in (9, 5):                             # a second prompt reuses the graph and the cache
        prompt = torch.randn(1, prompt_len, 64, device="cuda")
        probs, pos = dec.prefill(prompt)
        seq = prompt
        assert np.allclose(probs, plain(seq), atol=1e-4)
        for token in (3, 17, 3, 31, 0, 12):
            seq = torch.cat([seq, embed.weight[token].reshape(1, 1, -1)], dim=1)
            probs = dec.step(token, pos); pos += 1
            assert np.allclose(probs, plain(seq), atol=1e-4), (prompt_len, token)
    print("decoder: graph steps match a plain forward")


if __name__ == "__main__":
    check_sampler_matches_upstream()
    check_repetition_fallback()
    print("sampler: same candidates as upstream; repetition fallback holds")
    check_decoder_matches_plain_forward()
    print("ok")
