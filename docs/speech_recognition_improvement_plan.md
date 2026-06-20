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
- Wake phrases currently include `Mana`, `Manah`, `Manna`, `Mannah`, `Myna`, `My Na`, and `wake up`.

Planned work
- Add configurable Whisper model profiles so accuracy can be traded against latency.
- Bias Whisper toward Singapore English with an initial prompt and fixed English language mode.
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

Singapore English starting settings
- `WHISPER_LANGUAGE=en`
- `WHISPER_THREADS=6`
- `WHISPER_BEAM_SIZE=5`
- `WHISPER_NO_SPEECH_THRESHOLD=0.45`
- `WHISPER_PROMPT` should mention Singapore English, Mana wake words, and common Singlish particles.
- For better accent recognition, prefer `ggml-base.en.bin` or `ggml-small.en.bin` over `ggml-tiny.en.bin` if latency is acceptable.

Speech debug mode
- Browser-side debug: set `localStorage.manaSpeechDebug = "1"` in the Electron dev console, then restart listening.
- Backend debug: set `SPEECH_DEBUG=1` before starting `node-bot`.
- Debug output includes audio RMS, peak, zero-crossing rate, skip reason, transcript, and Whisper timing/config.
- Disable browser-side debug with `localStorage.removeItem("manaSpeechDebug")`.

Voice sample format
- Best format: `.wav`.
- Preferred encoding: mono, 16-bit PCM.
- Preferred sample rate: 16kHz or 48kHz.
- Keep each sample short: 3-10 seconds.
- Record separate samples for wake words, normal commands, quiet speech, and speech while FFXIV is running.
- Avoid background music in test samples unless the goal is specifically testing noisy conditions.
