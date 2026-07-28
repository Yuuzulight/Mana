# Issue 219: Voice barge-in (interrupt Mana mid-speech)

## Status: Phase 1 (hotkey) and Phase 2 (voice, experimental/opt-in) both built.

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

## Phase 2 (built, experimental, OFF by default): voice barge-in

Interrupting by just talking over Mana, instead of only via hotkey. Set
`MANA_BARGE_IN_VOICE=1` to enable.

### Why this is safe enough to ship as opt-in, unlike a blanket "always listen"

The mic-pause-during-playback gate exists specifically to avoid the mic
picking up Mana's own TTS voice through the speakers. Two things make
listening during playback less risky than it sounds, without solving full
echo cancellation from scratch:

1. `ensureMediaStream()` has only ever called
   `getUserMedia({ audio: true })` -- Chromium's default constraints for
   that call already include `echoCancellation: true`. Because Mana's reply
   audio is played back through an `<audio>` element in the same renderer
   process, Chromium's WebRTC-derived AEC can use what it's currently
   rendering to that output device as a reference signal and subtract it
   from the mic input before this feature ever sees the samples -- the same
   mechanism that makes speakerphone video calls not pick up their own
   audio. This isn't new code; it's already active for every mic capture
   Mana does, this feature just runs during a window it didn't run in
   before.
2. On top of that, `nextBargeInState()` (`renderer/voice-endpointing.js`)
   requires `MANA_BARGE_IN_HOLD_MS` (350ms default) of *continuous*
   Silero-VAD-positive speech before triggering -- a single echo blip or
   pop that leaks past AEC resets the timer instead of accumulating toward
   a trigger.

### Why it's still off by default

Real acoustic paths (mic gain, speaker volume, distance, room reflections)
vary a lot by hardware, and AEC quality varies by OS/driver. Nothing here
was verified against real speakers and a real mic in this session -- there's
no way to drive live audio hardware from this environment to confirm actual
echo-rejection behavior, only to verify the code is wired correctly and the
pure hold-time logic is correct in isolation (`voice-endpointing.test.js`).
Treat this as a build the user should audition on their own hardware before
trusting it, not a verified-working feature -- if it misfires (Mana cuts
herself off on her own echoed voice), raise `MANA_BARGE_IN_HOLD_MS` first;
if that's not enough, it needs to stay off.

### Implementation

- `renderer/voice-endpointing.js`: `nextBargeInState({ isSpeech,
  speechStartedAt, now, holdMs })` -- pure hold-time gate, mirrors the
  existing `shouldStopRecording()` pattern in the same file (a pure
  decision function separated from the mic/DOM plumbing so it's unit
  testable). Tested in `test/voice-endpointing.test.js`.
- `renderer/renderer.js`: `watchForBargeIn()` -- runs only while
  `currentReplyAudio` is set, reusing the same `mediaStream` and
  `getSileroVad()` instance normal listening uses (one audio pipeline, not
  two), polling every `BARGE_IN_POLL_MS` (50ms) and calling
  `stopReplyAudio()` once `nextBargeInState()` reports `triggered`. Started
  from `playAudioBlob()` right after playback begins, gated on
  `BARGE_IN_VOICE_ENABLED` (`MANA_BARGE_IN_VOICE === "1"`).
