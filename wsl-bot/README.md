WSL bot (voice bridge) - README

Overview
--------
This folder contains a small voice bridge that runs inside WSL (Ubuntu) and provides these features:

- Transcribe audio using faster-whisper (/transcribe endpoint)
- Query a locally-running text-generation-webui instance (if available) for a reply
- Synthesize the reply to WAV using Coqui TTS (/synthesize endpoint)

Status
------
This path is currently legacy. The active launcher integration in `../windows-launcher` starts `../node-bot/server.js` instead.

The Python WSL bridge remains in the repository as an older experiment and reference implementation.

Quick setup (inside WSL)
------------------------
1. Place this directory in your WSL home: e.g. /home/<user>/wsl-bot

2. Install dependencies and start the service (from inside WSL):

   cd ~/wsl-bot
   ./start.sh

3. start.sh will create a Python venv, install Python dependencies, start the voice_bridge
   and attempt to start text-generation-webui if it exists at ~/wsl-bot/text-generation-webui.

4. If you want to use the community 7B GGUF model with text-generation-webui:
   - Clone webui into ~/wsl-bot/text-generation-webui
     git clone https://github.com/oobabooga/text-generation-webui.git ~/wsl-bot/text-generation-webui
   - Place your GGUF model file into ~/wsl-bot/text-generation-webui/models/
   - Start the webui manually (the exact command can vary by webui version). Example:
     cd ~/wsl-bot/text-generation-webui
     python server.py --model <your-model-file> --listen --port 7860

How the Windows launcher integrates
----------------------------------
This section describes the historical integration design, not the current default launcher path.

Originally, the Windows Electron app was intended to call `wsl.exe` to run `~/wsl-bot/start.sh`.
That script starts the voice bridge and optionally starts `text-generation-webui`.

Notes and troubleshooting
-------------------------
- Make sure you have WSL2 and CUDA for WSL installed (Windows NVIDIA driver + CUDA toolkit in WSL).
- If faster-whisper or TTS installation fails, check your Python version (Python 3.10+ recommended) and
  ensure pip can compile wheels (install build-essential inside WSL if needed).
- The bridge assumes text-generation-webui exposes a chat/generation API on http://localhost:7860.
  If your webui version uses a different endpoint, edit `voice_bridge.py::query_model()` to match your API.

