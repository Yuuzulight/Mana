# #1454: CosyVoice2 / Fun-CosyVoice3 on the fast runtime. After AutoModel(...): enable(model). CosyVoice's own files
# stay as they are (tools/cosyvoice/CosyVoice).
#
# - Speech tokens: its Qwen2 LM through GraphDecoder (bf16, fixed-size cache, a CUDA graph a step) and CpuSampler
#   with its own sampling settings (ras_sampling's top_p, top_k, win_size, tau_r).
# - Streaming: the first chunk's size doubled after every chunk and was never reset between requests (25 -> 50 ->
#   100 tokens), and new tokens were checked for every 100 ms. Reset per request, checked every 5 ms.
# - First chunk: it waited for the reference clip's speech tokens to be padded up to a whole chunk (Mana's 9 s clip:
#   22 tokens, about 0.4 s) before any audio. The flow's prompt is trimmed from its start to whole chunks instead.
import functools, time, types
import torch
from .decoder import GraphDecoder, generate
from .sampling import CpuSampler


def align_prompt(kwargs, hop):
    """The flow's prompt cut from its start to a whole number of chunks (hop tokens, two mel frames each), so the
    first chunk needn't wait for padding. Left as it is when it's under one chunk or the frames don't line up."""
    tok, feat = kwargs.get("flow_prompt_speech_token"), kwargs.get("prompt_speech_feat")
    if tok is None or feat is None:
        return kwargs
    n = tok.shape[1]
    cut = n % hop
    if not cut or n - cut < hop or feat.shape[1] != 2 * n:
        return kwargs
    return dict(kwargs, flow_prompt_speech_token=tok[:, cut:], prompt_speech_feat=feat[:, 2 * cut:])


def enable(model, max_cache_len=4096, dtype=torch.bfloat16, seed=None):
    import cosyvoice.cli.model as cosy_model
    lm = model.model.llm
    if torch.cuda.is_available() and not hasattr(lm, "vllm"):
        causal = lm.llm.model                                   # Qwen2ForCausalLM
        for part in (causal, lm.llm_decoder, lm.speech_embedding, getattr(lm, "llm_embedding", None)):
            if part is not None:
                part.to(dtype)                                  # llm_embedding: CosyVoice2's sos and task id
        decoder = GraphDecoder(causal.model, lm.llm_decoder, lm.speech_embedding, max_cache_len=max_cache_len, dtype=dtype)
        k = dict(lm.sampling.keywords) if isinstance(lm.sampling, functools.partial) else {}
        sampler = CpuSampler(top_k=k.get("top_k", 25), top_p=k.get("top_p", 0.8), eos=lm.speech_token_size,
                             win_size=k.get("win_size", 10), tau_r=k.get("tau_r", 0.1), seed=seed)

        def inference_wrapper(lm_input, sampling, min_len, max_len, uuid):
            # Upstream runs this under fp16 autocast; the graph has its own precision.
            with torch.inference_mode(), torch.autocast("cuda", enabled=False):
                yield from generate(decoder, sampler, lm_input, max_len, set(lm.stop_token_ids), min_len=min_len)
        lm.inference_wrapper = inference_wrapper

    cosy_model.time = types.SimpleNamespace(sleep=lambda s: time.sleep(min(s, 0.005)), time=time.time)
    inner = model.model
    hop = getattr(inner, "token_hop_len", None)
    if hop is not None:
        tts = inner.tts

        def tts_from_first_chunk_size(*a, **k):
            inner.token_hop_len = hop
            yield from tts(*a, **align_prompt(k, hop))
        inner.tts = tts_from_first_chunk_size
    return model
