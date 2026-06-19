Fish Speech Install Status

What was done
- Fish Speech was added as a Git submodule at `tools/fish-speech`.
- WSL `uv` was installed at `/home/user/.local/bin/uv`.
- WSL Python `3.12.13` was installed through `uv`.
- A Fish Speech virtual environment was created at `tools/fish-speech/.venv`.

Current blocker
- `uv sync --extra cu128` failed while building `pyaudio`.
- WSL is missing build tools and PortAudio headers.
- `sudo` requires an interactive password, so these packages were not installed automatically.

Run this manually in Ubuntu/WSL:

```bash
sudo apt-get update
sudo apt-get install -y build-essential portaudio19-dev
```

Then retry:

```bash
cd /mnt/c/ManaAI/Mana/tools/fish-speech
/home/user/.local/bin/uv sync --extra cu128
```

Hardware note
- Local GPU detected: NVIDIA GeForce RTX 3070 Ti, 8GB VRAM.
- Fish Speech docs mention 24GB VRAM for inference, so local server performance may be limited.
- Mana can already use `TTS_PROVIDER=fish` with Kokoro fallback while Fish Speech is being evaluated.
