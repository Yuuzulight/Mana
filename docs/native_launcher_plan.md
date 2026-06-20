# Native Windows Launcher

This is the planned low-memory replacement for the Electron launcher.

## Goal

Keep Mana's gameplay runtime lighter by replacing Electron with a native Windows tray app and transparent PNG overlay.

Expected memory shape:
- native tray and overlay: much smaller than Electron
- `node-bot`: existing local backend
- Kokoro TTS: existing local TTS service

This is the realistic path toward a roughly 500 MB runtime while keeping local TTS.

## Current native scaffold

The `windows-native-launcher` project currently includes:
- tray icon
- transparent click-through PNG overlay
- existing Mana avatar asset reuse
- Kokoro startup without Chatterbox fallback
- `node-bot` startup
- `/perf/status` integration

The Electron launcher remains the supported full launcher until microphone capture and audio playback are migrated.

## Build requirement

This machine currently has the .NET 8 runtime but not the .NET SDK.

Install the .NET 8 SDK, then build:

```powershell
cd C:\ManaAI\Mana\windows-native-launcher
dotnet build
dotnet run
```

## Next implementation steps

1. Move microphone recording from Electron to C#.
2. Send recorded WAV chunks to `POST /transcribe-only`.
3. Keep the wake-word/session-awake behavior.
4. Send commands to `POST /reply`.
5. Play `POST /synthesize` WAV replies through native audio playback.
6. Drive avatar state from native speech playback.

## Fallback

Keep using `windows-launcher` until the native launcher reaches feature parity.
