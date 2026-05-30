Native Windows bot (win-bot)

This folder contains a PowerShell start script to run the voice bridge and (optionally) text-generation-webui natively on Windows (no WSL required).

Instructions
------------
1. Prerequisites
   - Windows 11
   - Python 3.10+ (Add to PATH)
   - Visual Studio Build Tools (C++ workload)
   - Latest NVIDIA driver for your GPU (RTX 30 series)
   - Node.js (for the Electron launcher)

2. Install PyTorch with CUDA support (example for CUDA 11.8):
   Open PowerShell and run:
     python -m pip install --upgrade pip
     python -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118

   Verify in Python:
     import torch
     torch.cuda.is_available()  # should be True
     torch.cuda.get_device_name(0)

3. Start the bot (PowerShell)
   - Open an elevated or normal PowerShell in this folder (C:\ManaAI\Mana\win-bot)
   - Run:
       .\start.ps1

   The script will create a venv, install Python dependencies (from ../wsl-bot/requirements.txt), start text-generation-webui if found in ../wsl-bot/text-generation-webui and start voice_bridge.py.

4. Start the Electron launcher (Windows)
   - In Windows PowerShell (different shell), run:
       cd C:\ManaAI\Mana\windows-launcher
       npm install
       npm run start

   The Electron app opens a small Push-to-Talk UI. When started it will launch this native start script.

Notes & troubleshooting
-----------------------
- If pip fails to build some packages, ensure Visual C++ build tools are installed and the appropriate CUDA-enabled PyTorch wheel is installed.
- If you prefer to run services interactively for logs/debugging, open a PowerShell window and run the voice bridge manually:
    python ..\wsl-bot\voice_bridge.py

- If text-generation-webui startup command differs for your version, edit start.ps1 and change the server start arguments accordingly.
