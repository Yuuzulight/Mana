"""Generates takes of Mana's narration lines in her voice: Fish Speech
S1-mini, cloned from two expressive Mitsuki clips. The app's own .env reference
(gpt-sovits-mitsuki.wav) is the flattest clip in tts-service/references
(~7 semitones of pitch range vs 16-17 for these two), and S1-mini copies the
reference's delivery along with its timbre -- so narration cloned from it
came out monotone.

Run with the Fish Speech venv, from anywhere:
  tools/fish-speech/.venv-native/Scripts/python.exe marketing/showreel/narrate.py [key ...]
Pass line keys to regenerate only those lines. Then run pick_takes.py to
choose one take per line.
"""

import os
import pathlib
import sys
import wave

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
FISH = REPO / "tools" / "fish-speech"
TAKES = HERE / "audio" / "narration" / "takes"
REF_DIR = REPO / "tts-service" / "references"

# transcripts from whisper-cli (ggml-base); cloning quality depends on them being exact
REFS = [
    ("mitsuki-2.wav", "Oh, look who finally decided to wake up. I was starting to think you turned into a statue, "
                      "you sleepyhead. Here, I made some tea for you, so stop yawning."),
    ("mitsuki-6.wav", "Seriously though, you always take care of everyone else, but you need to rest too. "
                      "I'm always in your corner, big brother. Now open wide. Say ah! Hey! Don't laugh!"),
]

# (key, spoken line, S1-mini delivery tag or None) -- keys match the storyboard;
# VTuber-debut-style self-introduction (see memory/character notes for lore)
LINES = [
    ("01-reveal", "Hi hi! Can you hear me? Oh, it worked!", "excited"),
    ("02-name", "I'm Mana, a little mana-crystal spirit who lives in your PC!", None),
    ("03-nice", "Nice to meet you!", None),
    ("04-talk", "Talk to me, and I'll talk back!", None),
    ("05-screen", "I can see your screen, too.", None),
    ("06-code", "I'll fix your code, but only if you say yes.", None),
    ("07-game", "Gaming? I'll be quiet. Streaming? I'm in!", None),
    ("08-everything", "Phone, Discord, and pretty much everything else.", None),
    ("09-memory", "And I remember what we did together.", "soft tone"),
    ("10-tease", "Fair warning: I like to tease!", None),
    ("11-promise", "Everything stays on your PC.", None),
    ("12-signoff", "Can't wait to meet you!", "excited"),
    # its own clip so it can get more takes and be picked for energy; kana so
    # S1-mini says it the Japanese way; the 〜 stretch was chosen by ear from
    # trials modelled on Gigi Murin's "Gii muriiin!" greeting
    ("13-otsumana", "おつ〜まな〜〜!!", "excited"),
]
SEEDS = [1, 2, 3, 4, 5]
EXTRA_SEEDS = {"13-otsumana": list(range(1, 7))}  # short exclamations drop out more often
# a notch hotter than tts-runtime.js's 0.8/0.8 defaults for livelier
# intonation; pick_takes.py's script check catches the takes that glitch
TEMPERATURE = 0.9
TOP_P = 0.9


def main():
    os.chdir(FISH)  # checkpoint paths are relative to the fish-speech checkout
    sys.path.insert(0, str(FISH))

    import numpy as np
    import torch
    import torch._inductor.config as inductor_config
    from loguru import logger

    logger.remove()
    inductor_config.use_static_cuda_launcher = False  # see native_infer.py

    import fish_speech.models.text2semantic.inference as t2s
    from fish_speech.inference_engine import TTSInferenceEngine
    from fish_speech.models.dac.inference import load_model as load_decoder_model
    from fish_speech.utils.schema import ServeReferenceAudio, ServeTTSRequest

    # Build the LLaMA directly on the GPU: upstream constructs it on the CPU
    # in fp32 first before moving it over. The worker thread that calls
    # init_model looks it up on the module, so patching it here reaches that
    # thread; the device context is entered inside the thread.
    orig_init = t2s.init_model

    def init_on_device(checkpoint_path, device, precision, compile=False):
        with torch.device(device):
            return orig_init(checkpoint_path, device, precision, compile)

    t2s.init_model = init_on_device

    refs = [ServeReferenceAudio(audio=(REF_DIR / f).read_bytes(), text=t) for f, t in REFS]

    llama_queue = t2s.launch_thread_safe_queue(
        checkpoint_path="checkpoints/openaudio-s1-mini", device="cuda", precision=torch.bfloat16, compile=False)
    decoder = load_decoder_model(
        config_name="modded_dac_vq", checkpoint_path="checkpoints/openaudio-s1-mini/codec.pth", device="cuda")
    engine = TTSInferenceEngine(llama_queue=llama_queue, decoder_model=decoder, precision=torch.bfloat16, compile=False)

    wanted = set(sys.argv[1:])
    TAKES.mkdir(parents=True, exist_ok=True)
    for key, text, tag in LINES:
        if wanted and key not in wanted:
            continue
        for seed in EXTRA_SEEDS.get(key, SEEDS):
            req = ServeTTSRequest(
                text=f"({tag}) {text}" if tag else text, references=refs,
                max_new_tokens=1024, chunk_length=300, top_p=TOP_P, repetition_penalty=1.1,
                temperature=TEMPERATURE, format="wav", streaming=False, seed=seed, use_memory_cache="on")
            results = list(engine.inference(req))
            final = next((r for r in results if r.code == "final"), None)
            if final is None:
                err = next((r.error for r in results if r.code == "error"), "unknown")
                print(f"{key} s{seed}: synthesis failed: {err}", flush=True)
                continue
            sr, audio = final.audio
            pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
            with wave.open(str(TAKES / f"{key}-s{seed}.wav"), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(sr)
                w.writeframes(pcm.tobytes())
            print(f"{key} s{seed}: {len(audio) / sr:.2f}s", flush=True)


if __name__ == "__main__":
    main()
