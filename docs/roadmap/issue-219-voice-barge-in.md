# Issue 219: Voice barge-in (interrupt Mana mid-speech)

## Status: Phase 1 built (hotkey interrupt). Phase 2 (wake-word-during-speech) out of scope.

## Background

Comparable local companion projects (Open-LLM-VTuber, moeru-ai/airi) treat
letting the user interrupt the AI's speech as core UX. Mana had no way to
do this -- once a reply started playing, the user had to wait it out.

An earlier research pass suggested Mana lacked voice-activity detection
entirely. That's wrong: Mana already has Silero-VAD-based end-of-speech
detection for normal turn-taking (see `silero-vad.test.js`,
`voice-endpointing.test.js`). The real gap is narrower -- interrupting
Mana's *own* speech output while it's playing.

## Why the mic doesn't just listen during playback

`windows-launcher/renderer/renderer.js`'s `listenLoop()` explicitly gates:

```js
if (processing || currentReplyAudio) {
  // skip recording
}
```

This is deliberate, not an oversight: without real echo cancellation, the
mic would risk transcribing Mana's own voice coming out of the speakers as
if it were the user talking. Removing this gate outright would be a new,
worse bug (Mana interrupting/responding to itself).

`stopReplyAudio()` already exists and does exactly what an interrupt needs:
bumps `replyPlaybackToken` (so any in-flight audio promise becomes stale),
pauses and nulls `currentReplyAudio`, and resets avatar state. It's already
called internally whenever a new reply supersedes an old one -- this issue
just exposes it as a direct user action too.

## Phase 1 (built): global hotkey interrupt

`windows-launcher/main.js`:
- `INTERRUPT_HOTKEY` (default `Control+Alt+I`, override via
  `MANA_INTERRUPT_HOTKEY`, `"0"`/`"off"` disables), mirroring the existing
  `VISION_HOTKEY`/`WINDOW_HOTKEY` pattern exactly.
- `registerInterruptHotkey()`, mirroring `registerVisionHotkey()`: disabled
  check, `globalShortcut.register()` with success/failure logging, try/catch,
  sends an `"interrupt-speech"` IPC message to the renderer rather than
  handling anything in the main process. Called alongside the other two
  hotkey registrations at startup. `globalShortcut.unregisterAll()` already
  runs at shutdown, so no new cleanup was needed.

`windows-launcher/renderer/renderer.js`:
- `ipcRenderer.on("interrupt-speech", () => stopReplyAudio())`, placed next
  to the existing `vision:hotkey` listener -- the renderer already owns
  `stopReplyAudio()` and the speech flow, so this is a thin wire-up, not new
  logic.

`desktop-client` has no equivalent listen/speech loop (confirmed via grep,
zero matches for `listenLoop`/`currentReplyAudio`), so there's no
dual-app-parity gap here -- this feature only applies where it's relevant.

### Why no click target

The issue's scope mentioned "a hotkey and/or a click target." A global
hotkey alone satisfies "let the user interrupt Mana" with the smallest
diff; a click target would need picking an element that isn't already
bound to something else in the avatar/chat window and is worth the extra
surface. Skipped for this pass -- add if a hotkey turns out to be
undiscoverable enough in practice that users want a visible button too.

### Why no new automated test

Precedent (`vision-hotkey.test.js`) tests the *pure logic* extracted from
vision-hotkey handling (prompt text, error-message mapping), not
`registerVisionHotkey()` itself -- registering a real Electron global
shortcut and sending a real IPC message isn't something the existing test
setup exercises for any of the three hotkeys. `registerInterruptHotkey()`
and the one-line IPC listener follow that same pattern with no new pure
logic to extract, so there's nothing to add a dedicated test for beyond
what already covers `stopReplyAudio()` itself. Verified manually instead
via `node --check` on both edited files.

## Phase 2 (explicitly out of scope): wake-word-during-speech

Interrupting by voice (saying Mana's name, or any speech) while she's still
talking, instead of only via hotkey. Deferred because it needs real
mitigation for the echo/false-positive risk described above (e.g. actual
echo cancellation, or gating on a wake-word-only pass that ignores audio
matching Mana's own output) -- none of which exists yet. Revisit if hotkey
interrupt proves insufficient in practice.
