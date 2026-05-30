Quick start (Windows + WSL2)

1) Install prerequisites on Windows
   - Windows 11 (you have)
   - Install Node.js (LTS) from https://nodejs.org
   - Install Git for Windows
   - Ensure WSL2 + Ubuntu is installed (see wsl_cuda_setup.md)

2) Put WSL bot files in your WSL home
   - From Windows PowerShell (or manually), copy the `wsl-bot` folder into your WSL home directory.
     Example PowerShell command (runs wsl and makes a directory then uses tar to copy):

     wsl mkdir -p ~/wsl-bot
     # Use Windows file explorer to move files into \wsl$\Ubuntu\home\<user>\wsl-bot

   - Easiest: open WSL and `git clone` this repo inside WSL so the path is ~/wsl-bot.

3) (Optional) Install and prepare text-generation-webui in WSL
   - In WSL:
     cd ~/wsl-bot
     git clone https://github.com/oobabooga/text-generation-webui.git
     # Place your community 7B GGUF model into ~/wsl-bot/text-generation-webui/models/

4) Start the Windows launcher
   - In Windows PowerShell:
     cd C:\ManaAI\Mana\windows-launcher
     npm install
     npm run start

   - The Electron app will call WSL and run `~/wsl-bot/start.sh` which starts the voice bridge
     (and will try to start text-generation-webui if it exists).

5) Use Push-to-Talk
   - Hold the "Push to talk (hold)" button, speak, then release. The transcription and model reply will
     appear in the UI and the bot's reply will be spoken aloud (if TTS succeeded).

Troubleshooting
- If the voice bridge is unreachable, open WSL and run:
  cd ~/wsl-bot
  ./start.sh
  tail -f voice_bridge.log

- If web UI doesn't start automatically, start it manually inside WSL (see webui README) and confirm
  it listens on port 7860.

