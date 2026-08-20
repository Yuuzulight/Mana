# Desktop-Client Continuous Listening — Design

## Context

`windows-launcher` supports always-on voice interaction: the mic stays open, Silero VAD detects when the user starts and stops talking, and each utterance becomes a turn without the user pressing anything. `desktop-client` has no equivalent — voice input there is push-to-talk only (`#btnRecord`, `MediaRecorder`, mousedown/mouseup).

This is Sub-project A of bringing barge-in detection (GitHub issues #339, #340) to both apps. Those issues need a `watchForBargeIn()`-style monitor to hook into during TTS playback, and `desktop-client` has no listening loop at all to host one. This spec ports `windows-launcher`'s continuous-listening model — including its *current* stop-and-discard barge-in behavior — to `desktop-client`, bringing it to feature parity with what `windows-launcher` ships today. It does **not** include the resume/classify/hold state machine that #339's revised scoping describes — that is Sub-project B, designed and built once `desktop-client` has a barge-in monitor to receive it.

**Non-goals:** the #339/#340 interruption state machine (held remainder, transcript classification, resume/discard), any LLM-generation-abort work, and any change to `windows-launcher`'s existing behavior. This is a port, not a redesign of the thing being ported.

## Reference implementation (windows-launcher/renderer/renderer.js)

The port's behavioral contract is defined by this existing code, not reinvented:

- `silero-vad.js` — `createSileroVad({ort, modelUrl, threshold})` → `{processFrame(frame), reset(), isSpeech(probability), load()}`. Stateless per-frame speech-probability signal; not coupled to turn-boundary logic.
- `voice-endpointing.js` — `shouldStopRecording(...)`, the turn-boundary decision logic consuming the VAD signal plus a silence-duration timer.
- `ensureMediaStream()` (`renderer.js:1497-1502`) — opens `getUserMedia({audio:true})` once, lazily, on first use; the same stream is reused by every mic consumer (turn capture, barge-in monitor) so echo cancellation applies everywhere for free.
- `recordUntilSilence()` (`renderer.js:1513-1634`) — captures one turn: own `AudioContext`/`AnalyserNode`, feeds frames to Silero VAD, calls `shouldStopRecording` to decide when the turn ended, returns the captured audio.
- `listenLoop()` (`renderer.js:2577-2628`) — `while (listening) { if (processing || currentReplyAudio) { wait; continue } ...recordUntilSilence()... }`. Fully gated off during TTS playback and reply generation. On any error (including a `getUserMedia` rejection), catches it, sets an error status string, waits 1500ms, and retries — `listening` stays `true` indefinitely; there is no dedicated "permission denied, give up" state.
- `watchForBargeIn()` (`renderer.js:1143-1206`) — separate mic monitor, own `AnalyserNode` on the same stream, runs only while `currentReplyAudio` is truthy and `BARGE_IN_VOICE_ENABLED`. Polls every `BARGE_IN_POLL_MS` (50ms); requires `BARGE_IN_HOLD_MS` (default 350ms) of continuous VAD-positive speech before calling `stopReplyAudio()`. This is stop-and-discard only — no hold, no resume. This exact behavior (not #339's revised design) is what this spec ports.
- UI: `#listenToggle` button (`index.html:1351`), toggles `listening` via `startListening()`/`stopListening()`; `.active` CSS class + button text swap (`"Start listening"` / `"Stop listening"`) reflect state (`renderer.js:2638-2648`); `#statustxt` inside `#status` shows the current phase as plain text, rewritten at each transition (`"Waiting for Mana..."`, `"Mana is awake..."`, `"Mana is listening..."`, `"Mana is thinking..."`, `"Stopped"`, `"Listening error: ..."`, `"Microphone access failed: ..."`).
- Typing (`sendTypedMessage()`, `renderer.js:2341-2358`) runs fully independently of `listenLoop()` — it does not pause the mic. The only shared gate between voice and text is the `processing` flag, preventing both from triggering a reply at the same time.
- Autostart: `startListeningOnLaunch()` (`renderer.js:2699`) runs unconditionally once the backend health check passes — the mic effectively activates at app launch, not on first manual toggle. The toggle button is the manual override if autostart didn't run or was stopped.

## Desktop-client target state

**Files to create** (own copies, not shared modules — matching this codebase's established per-app-copy convention, e.g. `reply-emotion.js`/`live2d-logic.js`, `streaming-chunk-queue.js`):
- `desktop-client/renderer/silero-vad.js` — ported from windows-launcher's version; expected near-identical since it's a generic ONNX wrapper with no app-specific state.
- `desktop-client/renderer/voice-endpointing.js` — ported turn-boundary logic.

**Renderer additions** (`desktop-client/renderer/renderer.js`):
- `ensureMediaStream()`, `recordUntilSilence()`, `listenLoop()` — ported with the same gating (`processing`, and desktop-client's playback-active equivalent — check the current token/state variable guarding a reply in flight, likely `desktopReplyPlaybackToken`'s "is anything currently playing" check) and the same indefinite-retry-on-error behavior.
- A `watchForBargeIn()`-equivalent, ported at today's windows-launcher behavior: VAD + hold-duration gate, stop-and-discard on trigger (call whatever this app's `stopReplyAudio`/`stopStreamingReply`-equivalent is). No held state, no resume — matching the thing being ported, not #339's revised design.

**UI** (`desktop-client/renderer/index_fixed.html`):
- New `#btnListen` toggle button in `.input-actions`, alongside the existing `#btnRecord`. Same on/off semantics and active-state visual treatment as `#listenToggle` (label swap + an active/highlighted style), adapted to this app's existing button styling rather than copying windows-launcher's CSS literally.
- Status text extends the existing single `#status` span (`renderer.js:121`, currently written directly at each call site with strings like `'Idle'`, `'Listening...'`, `'Processing...'`) with the same phase strings windows-launcher shows, adapted to whatever phrasing consistency this app's existing status strings already establish (e.g. if desktop-client already says `'Listening...'` for push-to-talk recording, the continuous-listening idle-armed state needs its own distinct string so the two aren't confused — e.g. `'Waiting for you...'` vs the existing `'Listening...'` for active capture).
- New "Voice" settings section in `#settingsView`, following the existing `.settings-section` + checkbox pattern (`#brainProviderSection`/`#useRemoteAiToggle`/`#brainProviderFields` is the direct template — checkbox reveals a `hidden` details block). Contains one control: "Start listening automatically on launch" (checkbox, **default off** — a safer default than windows-launcher's unconditional autostart, since this app has never had an always-on mic before and users shouldn't be surprised by it turning on silently after an update). Fine-tuning knobs (VAD threshold, hold-ms, silence timeout) are **not** exposed in this UI — they stay env-var-only, matching windows-launcher's own approach, keeping the two apps' configuration surface consistent.

**Mic-permission lifecycle:** identical to windows-launcher — lazy `getUserMedia` on first `listenLoop` iteration, indefinite retry-with-1500ms-backoff on any error (including permission denial), status text shows the error string, no dedicated "permission denied, stop trying" UI state. Electron's permission handler (`desktop-client/main.js` — verify the equivalent of windows-launcher's `main.js:1075-1078` `setPermissionRequestHandler` exists or needs adding) must auto-grant media permission for the app's own content, matching windows-launcher's setup.

**Typing/push-to-talk interaction:** `sendTextMessage()` and `#btnRecord`'s push-to-talk continue to work exactly as they do today, unmodified. Continuous listening runs independently of both, gated only by the existing `processing`/`sendingTextMessage`-style flags so voice, text, and push-to-talk can't all trigger overlapping replies. Toggling `#btnListen` on does not disable `#btnRecord` — a user can still manually push-to-talk (e.g. to bypass a not-yet-detected utterance) while continuous listening is also active, matching how typing already coexists with the mic today.

## Error handling

Matches the reference implementation's philosophy throughout: this is a best-effort, always-retrying background loop, not a hard-fail feature. A missing ONNX runtime falls back the same way windows-launcher's does (`sileroVad` lazily created, missing/broken runtime doesn't block app start — check whether windows-launcher falls back to a plain RMS threshold in that case per its own code comments, and replicate that fallback rather than a hard failure). Mic permission errors retry indefinitely rather than surfacing a dead-end error state, matching the existing UX (imperfect, but consistent with what already ships).

## Testing

No existing automated test coverage exists for either app's continuous-listening/VAD logic today (confirmed: neither `windows-launcher/test/` nor `desktop-client/test/` has a file testing `listenLoop`/`recordUntilSilence`/`watchForBargeIn`'s actual behavior — `voice-endpointing.test.js` exists and tests `shouldStopRecording` as pure logic, which is the model to follow). The implementation plan should:
- Port `voice-endpointing.js` with its own `desktop-client/test/voice-endpointing.test.js`, mirroring `windows-launcher/test/voice-endpointing.test.js`'s existing test cases (pure logic, no DOM/Audio dependencies, directly portable).
- Verify the new `watchForBargeIn`-equivalent's hold-duration/trigger logic the same way Task 4 of the streaming-voice-reply work did for its chunk queue: extract the triggering decision into a small pure/testable unit where possible, and use a standalone harness or extracted-module test for anything that can't run without live DOM/Audio APIs.
- Manual verification via the `run` skill for the actual end-to-end mic/UI behavior, since neither app has real audio-hardware test infrastructure.

## Open questions for the implementation plan to resolve by reading the actual code

- The exact name of desktop-client's "is a reply currently playing" check (referenced above as `desktopReplyPlaybackToken`-based, needs confirming against the current `renderer.js`).
- Whether `desktop-client/main.js` already has a media-permission handler or needs one added (`windows-launcher/main.js:1075-1078` is the reference).
- Whether windows-launcher's Silero VAD load failure has a documented RMS-fallback path to replicate, or whether it hard-fails (its own code comments suggest a fallback exists — confirm before assuming).
