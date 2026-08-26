# Native Windows Launcher

This is the planned low-memory replacement for the Electron launcher.

## Goal

Keep Mana's gameplay runtime lighter by replacing Electron with a native Windows tray app and transparent PNG overlay.

Expected memory shape:
- native tray and overlay: much smaller than Electron
- `node-bot`: existing local backend
- Kokoro/Fish Speech TTS: existing local TTS services

This is the realistic path toward a roughly 500 MB runtime while keeping local TTS. **Not yet actually measured** -- see issue #479's research comment.

## Current native scaffold (issue #479 research, verified against the real code)

The `windows-native-launcher` project now includes the full core voice loop
(#479 sub-project 1, shipped in #480), not just the original scaffold:
- tray icon, transparent click-through PNG overlay, existing avatar asset reuse
- `node-bot` + Kokoro + Fish Speech (S1-mini) startup (#485), `/perf/status` integration
- **Microphone capture and audio playback are migrated** -- real NAudio WASAPI
  capture/playback (`VoiceLoop.cs`, `AudioPlayer.cs`), Silero VAD segmentation
  (`RecordingSegmenter.cs`, `SileroVadRunner.cs`), wake-word matching
  (`WakeWordMatcher.cs`), and all three backend calls
  (`POST /transcribe-only`, `POST /reply`, `POST /synthesize`) wired in
  `ManaBackendClient.cs`. The "Next implementation steps" list below this
  section used to describe is done -- kept only as a historical record.

## What's still missing for real feature parity

The native launcher is voice+avatar only -- no visible window besides the
tray menu and the transparent overlay. `windows-launcher` (Electron) has a
much broader surface with no native equivalent yet:
- Visible chat/session UI (`renderer/session-sidebar.js`, `sidebar-nav.js`,
  `markdown-render.js`, `streaming-chunk-queue.js`, `caption-client.js`)
- Screen-context/accessibility-tree integration (issue #343)
- Vision hotkey (`renderer/vision-hotkey.js`)
- Proactive toast notifications (issue #423)
- Quick-entry popup window (`quick-entry/`)
- Artifact viewer window (`artifact/`)
- Doctor/diagnostics panel (`renderer/doctor-panel.js`), compare-mode (`renderer/compare-mode.js`)

None of this is committed to being ported -- whether it's worth building
natively depends on how much of it is actually used day to day versus
voice+avatar being the primary interaction mode. That's a product decision,
not something this doc resolves.

## Build requirement

This machine currently has the .NET 8 runtime but not the .NET SDK.

Install the .NET 8 SDK, then build:

```powershell
cd C:\ManaAI\Mana\windows-native-launcher
dotnet build
dotnet run
```

## Next implementation steps (historical -- all shipped, see above)

1. Move microphone recording from Electron to C#.
2. Send recorded WAV chunks to `POST /transcribe-only`.
3. Keep the wake-word/session-awake behavior.
4. Send commands to `POST /reply`.
5. Play `POST /synthesize` WAV replies through native audio playback.
6. Drive avatar state from native speech playback.

## Fallback

Keep using `windows-launcher` until the native launcher reaches feature parity on the features listed above that still matter for real usage.
