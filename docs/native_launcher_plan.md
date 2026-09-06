# Native Windows Launcher

This is the low-memory replacement for the Electron launcher (`windows-launcher`).

## Goal

Keep Mana's gameplay runtime lighter by replacing Electron with a native Windows tray app and transparent PNG/Cubism overlay.

Expected memory shape:
- native tray and overlay: much smaller than Electron
- `node-bot`: existing local backend
- Kokoro/Fish Speech (S1-mini) TTS: existing local TTS services

This is the realistic path toward a roughly 500 MB runtime while keeping local TTS. **Not yet actually measured** -- no benchmark doc exists for this yet.

## Current state (verified against the real code, 2026-09-04)

`windows-native-launcher` is no longer a scaffold -- it covers the full voice+avatar loop plus most of the Electron launcher's secondary UI surfaces:

**Core voice loop** -- real NAudio WASAPI capture/playback (`VoiceLoop.cs`, `AudioPlayer.cs`), Silero VAD segmentation (`RecordingSegmenter.cs`, `SileroVadRunner.cs`), wake-word matching (`WakeWordMatcher.cs`), barge-in detection and held-reply resume (`BargeInGate.cs`), and all backend calls (`POST /transcribe-only`, `POST /reply/stream`, `POST /synthesize`) wired through `ManaBackendClient.cs`/`StreamingReplyPlayer.cs`.

**Avatar rendering** -- real, parameter-driven Live2D Cubism rendering (`Live2D/CubismModel.cs`, `CubismRenderer.cs`, motion/expression files, lip-sync driven live off playback samples) when the proprietary Cubism Core SDK and a model are installed, falling back to the original static idle/talking PNG swap when they aren't (`AvatarOverlayForm.cs`).

**Session/chat window** -- a dark-themed session list and chat log (`SessionListForm.cs`, `ChatLogPanel.cs`, `ChatMarkdown*.cs`), reachable from the tray and from toast notifications.

**Screen-context awareness** -- Windows UI Automation with an OCR fallback (`ScreenContextReader.cs`, `AccessibilityTreeOutputParser.cs`, `ScreenContextTrigger.cs`), gated by gaming-mode/keyword heuristics.

**Vision hotkey** -- Ctrl+Alt+M ("look at my screen"), screen capture plus a vision-flavored reply path (`VisionHotkeyListener.cs`, `VisionHotkeyMessages.cs`, `ScreenCapture.cs`).

**Proactive toast notifications** -- native Windows toasts with action buttons, routed back into the chat window on activation (`TrayNotificationClient.cs`, `TrayNotificationPayload.cs`, `ProactiveToastFilter.cs`).

**Quick-entry popup** -- Ctrl+Alt+Space to type a command without switching windows (`QuickEntryForm.cs`), through the same turn-processing path as voice.

**Artifact viewer window** -- with Mermaid diagram rendering (`ArtifactViewerForm.cs`, `ArtifactDetector.cs`, `MermaidParser.cs`/`MermaidLayout.cs`/`MermaidRenderer.cs`).

**Doctor panel and compare-mode** -- diagnostics and side-by-side model comparison (`DoctorPanelForm.cs`, `CompareModeForm.cs`).

**Settings** -- a dark-themed settings panel/dialog covering gaming mode, avatar, web access, vision, model/remote-AI, and theme (`SettingsPanel.cs`, `SettingsDialog.cs`, `DarkTheme.cs`).

## What's still missing for real feature parity

- **Live captions overlay** -- `windows-launcher`'s `caption-client.js` listens to node-bot's `/ws/captions` broadcast and shows spoken output on screen (issue #362). No native equivalent.
- **Capture-a-clip pipeline** -- the "what just happened?" hotkey and clip buffer (issue #450, `windows-launcher`'s `clip-buffer.js`). No native equivalent.

Everything else the original version of this doc listed as missing (visible chat/session UI, screen-context, vision hotkey, proactive notifications, quick-entry, artifact viewer, doctor panel, compare-mode) has since shipped, listed above.

Whether the two remaining items are worth building natively depends on actual usage patterns, not something this doc can decide.

## Build requirement

Requires the .NET 8 SDK (not just the runtime).

```powershell
cd windows-native-launcher
dotnet build
dotnet run
```

## Fallback

Keep using `windows-launcher` until the native launcher reaches feature parity on the two items listed above that still matter for real usage.
