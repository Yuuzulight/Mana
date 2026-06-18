# Mana

Mana is a local AI assistant that runs on Windows.

The supported path in this repository is:
- Electron desktop launcher in `windows-launcher`
- Local Node backend in `node-bot`
- `whisper.cpp` for speech-to-text
- `llama.cpp` for local text generation
- A configurable local TTS tool/model for spoken replies

The older Python `wsl-bot` and `win-bot` flows are still present in the repo, but they are legacy paths and are not the default launcher integration.

See `docs/quick_start_windows.md` for the current setup flow.
