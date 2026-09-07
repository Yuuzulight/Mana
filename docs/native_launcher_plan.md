# Native Windows Launcher

This is the low-memory replacement for the Electron launcher (`windows-launcher`).

## Goal

Keep Mana's gameplay runtime lighter by replacing Electron with a native Windows tray app and transparent PNG/Cubism overlay.

Expected memory shape:
- native tray and overlay: much smaller than Electron
- `node-bot`: existing local backend
- Kokoro/Fish Speech (S1-mini) TTS: existing local TTS services

This is the realistic path toward a roughly 500 MB runtime while keeping local TTS. **Not yet actually measured** -- no benchmark doc exists for this yet.

## Current state (verified against the real code, 2026-09-06)

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

**Settings** -- a dark-themed settings surface covering connection & admin-auth (#565), plugins, memory facts, a skills full editor (#581), the approval-gate queue, hooks (#566), MCP client registry (#567), admin accounts (#568), mobile companion pairing (#569), VTube Studio (#570), voice-provider override (#583), persona presets (#573), model/brain-provider (#572), mobile devices, accounts, a live backend log tail (#582), theme picker (#576), and a perf/token-usage panel (#575) (`SettingsPanel.cs`, `SettingsDialog.cs`, `DarkTheme.cs`).

**Live captions overlay** -- shows spoken output on screen, consuming node-bot's `/ws/captions` broadcast the same way `windows-launcher`'s `caption-client.js` does (issue #362, shipped as #571; `CaptionOverlayForm.cs`, `CaptionWebSocketClient.cs`).

**Capture-a-clip pipeline** -- the "what just happened?" hotkey and rolling clip buffer, matching `windows-launcher`'s `clip-buffer.js` (issue #450, shipped as #585; `ClipBuffer.cs`, `ClipHotkeyListener.cs`).

**Standalone panels/windows** -- gaming-mode toggle (#574), deep research (#577), browser-automation activity (#578), edit snapshots (#579), pending-edits proposals (#580), and global hotkeys for window-toggle/manual-interrupt (#584) (`ResearchForm.cs`, `BrowserAutomationPanel.cs`, `SnapshotsForm.cs`, `ProposalsForm.cs`, `GlobalHotkeyListener.cs`).

**Session management** -- inline goal editing and an open-memory modal from the session list's context menu (#586, `SessionListForm.cs`).

## What's still missing for real feature parity

Nothing outstanding. All items the original version of this doc listed as missing (visible chat/session UI, screen-context, vision hotkey, proactive notifications, quick-entry, artifact viewer, doctor panel, compare-mode, live captions, capture-a-clip) have shipped, along with the full #565-#586 settings/panel parity batch above. Deliberately dropped items (cloud sync, scheduled export, plugin marketplace install-by-URL, auto-updater, VRM/3D avatar support, first-run Python/venv setup) are tracked as their own follow-up issues rather than parity gaps -- see each one's own issue for why.

## Build requirement

Requires the .NET 8 SDK (not just the runtime).

```powershell
cd windows-native-launcher
dotnet build
dotnet run
```

## Fallback

The native launcher has reached feature parity with `windows-launcher`; `windows-launcher` is kept only as a fallback, not because of any known gap.
