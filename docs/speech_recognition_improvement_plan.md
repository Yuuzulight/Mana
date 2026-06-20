Speech Recognition Improvement Plan

Issue
- Tracks GitHub issue #4.

Goal
- Make Mana hear wake phrases and normal speech more reliably while staying local and responsive.
- Keep blank audio, keyboard clicks, mouse clicks, and game sound effects from triggering replies.

Current path
- The Electron renderer records short microphone chunks.
- The renderer filters quiet or clicky chunks before sending audio to the backend.
- `node-bot` sends WAV audio to `whisper.cpp`.
- Wake phrases currently include `Mana`, `Manah`, `Manna`, `Mannah`, and `wake up`.

Planned work
- Add configurable Whisper model profiles so accuracy can be traded against latency.
- Add a speech recognition debug mode that logs chunk volume, skip reason, transcript, and timing.
- Add fuzzy wake phrase matching for common Whisper mis-transcriptions.
- Tune the quiet-speech threshold so quiet real speech is not skipped too aggressively.
- Normalize microphone audio before Whisper to reduce missed quiet phrases.
- Build a small WAV test harness for repeated speech/noise regression checks.
- Document recommended microphone and Whisper settings for gaming use.

Acceptance checks
- Wake phrase detection works in a quiet room and while FFXIV is running.
- Blank audio still produces no reply.
- Keyboard and mouse clicks still produce no reply.
- Quiet speech is less likely to be discarded before Whisper.
- Latency stays acceptable for normal back-and-forth conversation.

First implementation target
- Start with debug logging and a test harness.
- Use those measurements before changing thresholds or switching Whisper models.
