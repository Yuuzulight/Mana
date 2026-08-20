# Desktop-Client Continuous Listening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `windows-launcher`'s always-on continuous-listening voice loop (mic stays open, Silero VAD detects turn boundaries, playback-time barge-in monitoring) into `desktop-client`, which today only has push-to-talk.

**Architecture:** Copy the two pure, app-agnostic modules (`silero-vad.js`, `voice-endpointing.js`) verbatim. Extract `desktop-client`'s existing push-to-talk reply logic (currently inlined in `onRecordingStop`) into a shared `handleVoiceTurn(blob)` function so both push-to-talk and the new continuous loop feed the same transcribe→reply pipeline. Add a `listenLoop()`/`recordUntilSilence()` pair modeled directly on `windows-launcher`'s, gated by a new `#btnListen` toggle button. Add a `watchForBargeIn()`-equivalent wired into the per-chunk playback function, matching today's windows-launcher behavior exactly (stop-and-discard, VAD + hold-duration only — no resume/classify logic, that's a separate future piece). Add one new Settings toggle (autostart on launch), off by default.

**Tech Stack:** Vanilla JS Electron renderer, `onnxruntime-web` (already used by `windows-launcher`, loaded via `<script>` tag — same pattern needed here), Node's built-in `node:test`.

**Spec:** [docs/superpowers/specs/2026-08-20-desktop-client-continuous-listening-design.md](../specs/2026-08-20-desktop-client-continuous-listening-design.md)

## Global Constraints

- This is a port of `windows-launcher`'s *current* behavior, not a redesign. Do not add the #339 resume/classify/hold state machine — stop-and-discard barge-in only, matching `watchForBargeIn()` as it exists today.
- Each app keeps its own copy of `silero-vad.js`/`voice-endpointing.js` — no cross-app shared module (matches this codebase's established convention: `reply-emotion.js`/`live2d-logic.js`, `streaming-chunk-queue.js` are already separate per-app copies).
- Fine-tuning knobs (VAD threshold, hold-ms, silence timeout) are env-var-only, matching `windows-launcher` — no new Settings UI for those. Only the on/off autostart preference gets a UI control.
- Autostart-on-launch defaults to **off** (checkbox unchecked) — `windows-launcher`'s unconditional autostart is not replicated as a default, since `desktop-client` users have never had an always-on mic before.
- `#btnRecord` (push-to-talk) keeps working completely unchanged, regardless of whether continuous listening is on.
- Electron's media-permission auto-grant already exists in `desktop-client/main.js:219-222` — no change needed there.

---

## File Structure

- **Create** `desktop-client/renderer/silero-vad.js` — verbatim copy of `windows-launcher/renderer/silero-vad.js`.
- **Create** `desktop-client/renderer/voice-endpointing.js` — verbatim copy of `windows-launcher/renderer/voice-endpointing.js`.
- **Create** `desktop-client/test/voice-endpointing.test.js` — verbatim copy of `windows-launcher/test/voice-endpointing.test.js` (identical relative require path, so no changes needed).
- **Modify** `desktop-client/renderer/renderer.js` — extract `handleVoiceTurn`, add the listening loop, add the barge-in monitor, add the autostart preference.
- **Modify** `desktop-client/renderer/index_fixed.html` — add `#btnListen` button, add onnxruntime-web `<script>` tag, add the Voice settings section.
- **Modify** `desktop-client/renderer/style.css` — add `#btnListen.active` style.

---

## Task 1: Port `silero-vad.js` and `voice-endpointing.js`

**Files:**
- Create: `desktop-client/renderer/silero-vad.js`
- Create: `desktop-client/renderer/voice-endpointing.js`
- Create: `desktop-client/test/voice-endpointing.test.js`

**Interfaces:**
- Produces: `createSileroVad({ort, modelUrl, threshold}) → {processFrame(frame), reset(), isSpeech(probability), load()}` — consumed by Task 2/3.
- Produces: `shouldStopRecording({hasHeardSpeech, elapsedMs, msSinceLastSpeech, maxWaitForSpeechMs, silenceBufferMs, maxDurationMs}) → stopReason|null` — consumed by Task 2.
- Produces: `nextBargeInState({isSpeech, speechStartedAt, now, holdMs}) → {speechStartedAt, triggered}` — consumed by Task 3.

- [ ] **Step 1: Copy `silero-vad.js` verbatim**

```bash
cp windows-launcher/renderer/silero-vad.js desktop-client/renderer/silero-vad.js
```

Confirm no `windows-launcher`-specific paths or references exist inside it (there shouldn't be any — it's a generic ONNX wrapper with an injected `ort` and `modelUrl`).

- [ ] **Step 2: Copy `voice-endpointing.js` verbatim**

```bash
cp windows-launcher/renderer/voice-endpointing.js desktop-client/renderer/voice-endpointing.js
```

- [ ] **Step 3: Copy the test file verbatim**

```bash
cp windows-launcher/test/voice-endpointing.test.js desktop-client/test/voice-endpointing.test.js
```

The file's `require("../renderer/voice-endpointing")` path is identical in both apps' directory structures (`test/` next to `renderer/`), so no edit is needed.

- [ ] **Step 4: Run the test to verify it passes as-is**

Run: `cd desktop-client && node --test test/voice-endpointing.test.js`
Expected: PASS (14 tests) — this is a straight port of pure logic with no desktop-client-specific dependencies, so it should pass unmodified.

- [ ] **Step 5: Commit**

```bash
git add desktop-client/renderer/silero-vad.js desktop-client/renderer/voice-endpointing.js desktop-client/test/voice-endpointing.test.js
git commit -m "Port silero-vad.js and voice-endpointing.js into desktop-client"
```

---

## Task 2: Continuous listening loop + toggle button

**Files:**
- Modify: `desktop-client/renderer/renderer.js` (extract `handleVoiceTurn`, add `ensureMediaStream`, `recordUntilSilence`, `listenLoop`, `startListening`/`stopListening`)
- Modify: `desktop-client/renderer/index_fixed.html:7` (add onnxruntime-web script tag), `:117` area (add `#btnListen` button)
- Modify: `desktop-client/renderer/style.css` (add `#btnListen.active`)

**Interfaces:**
- Consumes: `createSileroVad`, `FRAME_SAMPLES`/`SAMPLE_RATE` (as `VAD_FRAME_SAMPLES`/`VAD_SAMPLE_RATE`) from Task 1's `silero-vad.js`; `shouldStopRecording` from Task 1's `voice-endpointing.js`.
- Consumes: existing `mediaStream`/`recorder`/`chunks` state (`renderer.js:212-214`), existing `statusEl` (`renderer.js:121`), existing `setSprite()`, existing `speakStreamingReply()` (`renderer.js:578`), existing `appendMessage()`, existing `ensureSessionId()`, existing `selectedPresetId`.
- Produces: `handleVoiceTurn(blob)` — the shared transcribe→reply function, callable from both push-to-talk and the new loop.
- Produces: `let listening = false` — module-scope flag Task 3 will read (barge-in monitor doesn't touch it, but later work tracking overall voice state may).

Before writing code, re-read the actual current `desktop-client/renderer/renderer.js` around lines 758-842 (`setupRecording`/`startRecording`/`stopRecording`/`onRecordingStop`) and lines 630-647 (`init()`) — this plan's line numbers are accurate as of this plan's writing but may have drifted; confirm the code shapes below still match before editing.

- [ ] **Step 1: Extract `handleVoiceTurn` from `onRecordingStop`**

Replace the current `onRecordingStop` (`renderer.js:798-842`):

```js
  async function onRecordingStop(){
    const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
    try{
      // Issue #331: transcription and reply generation are now two calls
      // instead of one -- /transcribe-only has no streaming equivalent
      // (it's a plain multipart upload), so it just gets the transcript;
      // the reply itself goes through /reply/stream (via
      // speakStreamingReply) the same way sendTextMessage's does, so voice
      // replies get the same early-audio-start pipelining as typed ones.
      const form = new FormData();
      form.append('file', blob, 'voice.webm');
      const resp = await fetch('http://127.0.0.1:5005/transcribe-only', { method: 'POST', body: form });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error('transcribe failed: ' + resp.status + ' ' + txt);
      }
      const j = await resp.json().catch(()=>null);
      if (j && j.transcript) appendMessage('user', j.transcript);
      else appendMessage('user', JSON.stringify(j));

      if (j && j.transcript) {
        // Issue #331 review (Finding 1): append to the chat log as soon as
        // the final event names the reply, not after speakStreamingReply
        // resolves -- that await also waits for every queued chunk to
        // finish *playing*.
        const result = await speakStreamingReply(
          {
            text: j.transcript,
            sessionId: ensureSessionId(),
            presetId: selectedPresetId || undefined,
          },
          (finalEvent) => {
            if (!finalEvent.error && finalEvent.reply) appendMessage('assistant', finalEvent.reply);
          },
        );
        if (result.error) throw new Error(result.error);
      }

      statusEl.textContent = 'Idle';
    } catch (e){
      statusEl.textContent = 'Error';
      await window.electronAPI.showError(String(e));
      setSprite('idle');
    }
  }
```

with:

```js
  // Shared by push-to-talk (onRecordingStop) and continuous listening
  // (listenLoop) -- both produce a recorded utterance as a Blob and need
  // the exact same transcribe-then-reply handling.
  async function handleVoiceTurn(blob) {
    try{
      const form = new FormData();
      form.append('file', blob, 'voice.webm');
      const resp = await fetch('http://127.0.0.1:5005/transcribe-only', { method: 'POST', body: form });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error('transcribe failed: ' + resp.status + ' ' + txt);
      }
      const j = await resp.json().catch(()=>null);
      if (j && j.transcript) appendMessage('user', j.transcript);
      else appendMessage('user', JSON.stringify(j));

      if (j && j.transcript) {
        const result = await speakStreamingReply(
          {
            text: j.transcript,
            sessionId: ensureSessionId(),
            presetId: selectedPresetId || undefined,
          },
          (finalEvent) => {
            if (!finalEvent.error && finalEvent.reply) appendMessage('assistant', finalEvent.reply);
          },
        );
        if (result.error) throw new Error(result.error);
      }

      statusEl.textContent = 'Idle';
    } catch (e){
      statusEl.textContent = 'Error';
      await window.electronAPI.showError(String(e));
      setSprite('idle');
    }
  }

  async function onRecordingStop(){
    const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
    await handleVoiceTurn(blob);
  }
```

- [ ] **Step 2: Manually verify push-to-talk still works after the extraction**

Use the `run` skill to start `desktop-client`, hold `#btnRecord`, speak, release, and confirm the reply still appears and plays exactly as before. This step has no automated test (no test infra exists for this file's live behavior) — it is a behavior-preserving refactor and must be checked by hand before building on top of it.

- [ ] **Step 3: Add VAD state, constants, and `ensureMediaStream`**

Add near the existing `let mediaStream = null; let recorder = null; let chunks = [];` (`renderer.js:212-214`):

```js
  const {
    createSileroVad,
  } = require('./silero-vad');
  const {
    FRAME_SAMPLES: VAD_FRAME_SAMPLES,
    SAMPLE_RATE: VAD_SAMPLE_RATE,
  } = require('./silero-vad');
  const {
    shouldStopRecording,
    nextBargeInState,
    DEFAULT_MAX_WAIT_FOR_SPEECH_MS: MAX_WAIT_FOR_SPEECH_MS,
    DEFAULT_SILENCE_BUFFER_MS: SILENCE_BUFFER_MS,
    DEFAULT_MAX_UTTERANCE_MS: MAX_UTTERANCE_MS,
  } = require('./voice-endpointing');

  const VAD_THRESHOLD = Number(process.env.MANA_VAD_THRESHOLD || 0.5);
  const VAD_DISABLED = process.env.MANA_DISABLE_VAD === '1';
  const VAD_MODEL_URL = '../assets/vad/silero_vad.onnx';
  const MIN_SPEECH_RMS = Number(process.env.MANA_MIN_SPEECH_RMS || 0.012);
  const SILENCE_METER_INTERVAL_MS = 150;
  const LISTEN_PAUSE_MS = 250;

  let sileroVad = null;
  let sileroVadLoadFailed = false;
  let listening = false;

  function getSileroVad() {
    if (VAD_DISABLED || sileroVadLoadFailed || typeof window.ort === 'undefined') {
      return null;
    }
    if (!sileroVad) {
      sileroVad = createSileroVad({
        ort: window.ort,
        modelUrl: VAD_MODEL_URL,
        threshold: VAD_THRESHOLD,
      });
    }
    return sileroVad;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function ensureMediaStream() {
    if (!mediaStream) {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    return mediaStream;
  }
```

Note: `desktop-client` already opens `mediaStream` eagerly in `setupRecording()` at app init (unlike windows-launcher's fully-lazy version), so in practice `ensureMediaStream()` here is mostly a no-op safety net once `setupRecording()` has already run — keep it anyway, since it's what `recordUntilSilence`/the barge-in monitor call, and it's harmless if `mediaStream` is already set.

Check `desktop-client/renderer/index_fixed.html` for how `onnxruntime-web` is loaded today (it likely isn't yet — `windows-launcher/renderer/index.html` loads it via a classic `<script>` tag, same reasoning as the `silero-vad.js` header comment: Electron's `nodeIntegration` renderer would otherwise resolve `require("onnxruntime-web")` to the Node-native export instead of the browser WASM build). Add the equivalent `<script>` tag to `desktop-client/renderer/index_fixed.html` if missing — find the exact tag windows-launcher uses (grep `windows-launcher/renderer/index.html` for `onnxruntime` or `ort.min.js`) and add the same relative include, adjusting the path for `desktop-client`'s asset layout (check whether `desktop-client` already has the ONNX runtime files bundled somewhere, or whether they need to be added the same way `windows-launcher`'s were — check `windows-launcher/renderer/` for the actual asset location referenced by its script tag).

- [ ] **Step 4: Add `recordUntilSilence`**

```js
  async function recordUntilSilence({
    maxWaitForSpeechMs = MAX_WAIT_FOR_SPEECH_MS,
    silenceBufferMs = SILENCE_BUFFER_MS,
    maxDurationMs = MAX_UTTERANCE_MS,
  } = {}) {
    await ensureMediaStream();

    const vad = getSileroVad();
    if (vad) {
      vad.reset();
    }

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: VAD_SAMPLE_RATE,
    });
    const source = audioCtx.createMediaStreamSource(mediaStream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);

    function currentRms() {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) {
        sum += samples[i] * samples[i];
      }
      return Math.sqrt(sum / samples.length);
    }

    async function isSpeechNow() {
      if (vad) {
        try {
          analyser.getFloatTimeDomainData(samples);
          const frame = samples.subarray(samples.length - VAD_FRAME_SAMPLES);
          const probability = await vad.processFrame(frame);
          return vad.isSpeech(probability);
        } catch (e) {
          console.warn('Silero VAD inference failed, falling back to RMS for this session:', e);
          sileroVadLoadFailed = true;
        }
      }
      return currentRms() >= MIN_SPEECH_RMS;
    }

    return await new Promise((resolve, reject) => {
      const localChunks = [];
      const localRecorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm' });
      let hasHeardSpeech = false;
      let lastSpeechAt = 0;
      let meterTimer = null;
      let stopped = false;
      const startedAt = performance.now();

      function cleanup() {
        stopped = true;
        if (meterTimer !== null) {
          clearTimeout(meterTimer);
          meterTimer = null;
        }
        try {
          source.disconnect();
        } catch (e) {}
        audioCtx.close().catch(() => {});
      }

      localRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          localChunks.push(event.data);
        }
      };
      localRecorder.onerror = (event) => {
        cleanup();
        reject(event.error);
      };
      localRecorder.onstop = () => {
        cleanup();
        resolve(new Blob(localChunks, { type: 'audio/webm' }));
      };

      localRecorder.start(SILENCE_METER_INTERVAL_MS);

      async function tick() {
        if (stopped) return;
        if (await isSpeechNow()) {
          if (!hasHeardSpeech) {
            statusEl.textContent = 'Listening...';
          }
          hasHeardSpeech = true;
          lastSpeechAt = performance.now();
        }
        if (stopped) return;

        const stopReason = shouldStopRecording({
          hasHeardSpeech,
          elapsedMs: performance.now() - startedAt,
          msSinceLastSpeech: hasHeardSpeech ? performance.now() - lastSpeechAt : 0,
          maxWaitForSpeechMs,
          silenceBufferMs,
          maxDurationMs,
        });
        if (stopReason) {
          if (localRecorder.state !== 'inactive') {
            localRecorder.stop();
          }
          return;
        }
        meterTimer = setTimeout(tick, SILENCE_METER_INTERVAL_MS);
      }
      meterTimer = setTimeout(tick, SILENCE_METER_INTERVAL_MS);
    });
  }
```

This uses local `localChunks`/`localRecorder` variables rather than the module-scope `chunks`/`recorder` that push-to-talk's `startRecording`/`stopRecording` use — the continuous loop must not share mutable state with the push-to-talk path, since a user could in principle trigger both (push-to-talk while continuous listening is also active).

- [ ] **Step 5: Add `listenLoop`/`startListening`/`stopListening` and the `#btnListen` wiring**

```js
  async function listenLoop() {
    while (listening) {
      if (desktopReplyPlaybackToken !== null && document.getElementById('btnListen')?.dataset.playing === '1') {
        await wait(LISTEN_PAUSE_MS);
        continue;
      }
      try {
        statusEl.textContent = 'Waiting for you...';
        const blob = await recordUntilSilence();
        if (!listening) break;
        await handleVoiceTurn(blob);
      } catch (error) {
        console.error(error);
        statusEl.textContent = `Listening error: ${error.message}`;
        await wait(1500);
      }
    }
  }

  function startListening() {
    if (listening) return;
    listening = true;
    const btn = document.getElementById('btnListen');
    if (btn) {
      btn.textContent = 'Stop Listening';
      btn.classList.add('active');
    }
    listenLoop();
  }

  function stopListening() {
    listening = false;
    const btn = document.getElementById('btnListen');
    if (btn) {
      btn.textContent = 'Start Listening';
      btn.classList.remove('active');
    }
    statusEl.textContent = 'Idle';
  }

  document.getElementById('btnListen')?.addEventListener('click', () => {
    if (listening) {
      stopListening();
    } else {
      startListening();
    }
  });
```

**Important — the `desktopReplyPlaybackToken`/"is anything currently playing" gate in `listenLoop` above is a placeholder pattern, not verified code.** Before finalizing this step, read the actual current `desktop-client/renderer/renderer.js` around `speakStreamingReply`/`stopStreamingReply` (`renderer.js:557-632` as of this plan's writing) and find the real, simplest way to check "is a reply currently being synthesized or played" from outside that function — likely a new small boolean/counter this task needs to add (e.g. a module-scope `let replyInProgress = false` set `true` at the start of `speakStreamingReply` and `onRecordingStop`'s call, `false` in their `finally`), since `desktopReplyPlaybackToken` alone (a monotonically increasing counter) doesn't directly answer "is playback active right now" the way `windows-launcher`'s `currentReplyAudio` truthiness check does. Mirror `windows-launcher`'s `if (processing || currentReplyAudio) { wait; continue }` gate shape (`renderer.js:2580`) using whatever the real equivalent flags are in `desktop-client`, not the placeholder condition shown above.

- [ ] **Step 6: Add the `#btnListen` button and CSS**

In `desktop-client/renderer/index_fixed.html`, add next to the existing `#btnRecord` (`:117`):

```html
              <button id="btnListen">Start Listening</button>
```

In `desktop-client/renderer/style.css`, add near the existing `#btnResearch.active` rule (`:192`):

```css
#btnListen.active{background:var(--accent-glow);color:var(--accent);border-color:var(--accent-dim)}
```

- [ ] **Step 7: Manual verification**

Use the `run` skill to start `desktop-client`. Click `#btnListen`, confirm the button and status text reflect the listening state, speak a sentence, and confirm it's transcribed and replied to without pressing `#btnRecord`. Click `#btnListen` again to confirm it stops cleanly (no further transcription attempts, mic released or at least idle).

- [ ] **Step 8: Commit**

```bash
git add desktop-client/renderer/renderer.js desktop-client/renderer/index_fixed.html desktop-client/renderer/style.css
git commit -m "Add continuous listening loop and toggle to desktop-client"
```

---

## Task 3: Barge-in monitor

**Files:**
- Modify: `desktop-client/renderer/renderer.js` (add `watchForBargeIn`-equivalent, wire into the per-chunk play path)

**Interfaces:**
- Consumes: `nextBargeInState` from Task 1's `voice-endpointing.js`; `getSileroVad`, `ensureMediaStream`, `mediaStream`, `VAD_FRAME_SAMPLES`, `VAD_SAMPLE_RATE`, `wait` from Task 2.
- Consumes: `stopStreamingReply()` (`renderer.js:559-561`) as this app's stop-and-discard primitive, matching `windows-launcher`'s `stopReplyAudio()`.
- Consumes: `playDecodedChunk(audioCtx, audioBuffer, text)` (`renderer.js:544-555`) as the trigger point — mirrors `windows-launcher`'s `playAudioBlob`, which is where `watchForBargeIn()` is invoked from.

Before writing code, re-read the actual current `playDecodedChunk` and the surrounding `speakStreamingReply`/`createDesktopStreamingChunkQueue` wiring (`renderer.js:544-632` as of this plan's writing) — confirm the function signature and how it's invoked from the queue before adding the barge-in trigger.

- [ ] **Step 1: Add the barge-in constants and monitor function**

```js
  const BARGE_IN_VOICE_ENABLED = process.env.MANA_BARGE_IN_VOICE !== '0';
  const BARGE_IN_HOLD_MS = Number(process.env.MANA_BARGE_IN_HOLD_MS || 350);
  const BARGE_IN_POLL_MS = 50;

  let bargeInMonitor = null;

  // Matches windows-launcher's watchForBargeIn() exactly: runs only while
  // Mana is currently playing a chunk, requires BARGE_IN_HOLD_MS of
  // continuous VAD-positive speech (not just one frame) before triggering,
  // and is stop-and-discard only -- no hold/resume, matching today's
  // shipped behavior in the sibling app.
  async function watchForBargeIn(isStillPlaying) {
    if (bargeInMonitor) {
      return;
    }
    const self = { stopped: false };
    bargeInMonitor = self;

    try {
      await ensureMediaStream();
      const vad = getSileroVad();
      if (!vad) {
        return;
      }
      vad.reset();

      const audioCtx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: VAD_SAMPLE_RATE,
      });
      const source = audioCtx.createMediaStreamSource(mediaStream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);

      let speechStartedAt = null;
      try {
        while (!self.stopped && isStillPlaying()) {
          await wait(BARGE_IN_POLL_MS);
          if (self.stopped || !isStillPlaying()) {
            break;
          }

          let isSpeech = false;
          try {
            analyser.getFloatTimeDomainData(samples);
            const frame = samples.subarray(samples.length - VAD_FRAME_SAMPLES);
            const probability = await vad.processFrame(frame);
            isSpeech = vad.isSpeech(probability);
          } catch (e) {
            isSpeech = false;
          }

          const state = nextBargeInState({
            isSpeech,
            speechStartedAt,
            now: performance.now(),
            holdMs: BARGE_IN_HOLD_MS,
          });
          speechStartedAt = state.speechStartedAt;
          if (state.triggered) {
            stopStreamingReply();
            break;
          }
        }
      } finally {
        try {
          source.disconnect();
        } catch (e) {}
        audioCtx.close().catch(() => {});
      }
    } finally {
      bargeInMonitor = null;
    }
  }
```

Note the signature difference from `windows-launcher`'s version: it takes an `isStillPlaying()` callback instead of checking a module-scope `currentReplyAudio` variable directly, since `desktop-client`'s playback-active signal is whatever boolean/token check Task 2 Step 5 settled on (`desktopReplyPlaybackToken`-based) rather than a truthy `Audio` element. Wire the actual check through when calling this function in Step 2 below.

- [ ] **Step 2: Wire the monitor into the per-chunk play path**

In `playDecodedChunk` (or wherever the actual per-chunk audio starts playing after Task 2/the existing streaming-chunk-queue work — confirm the real call site), add, right after playback starts (mirroring `windows-launcher`'s `playAudioBlob` calling `watchForBargeIn()` immediately after `.play()`/`startLipSync()`, `renderer.js:1242-1248`):

```js
    if (BARGE_IN_VOICE_ENABLED) {
      const playbackTokenAtStart = desktopReplyPlaybackToken;
      watchForBargeIn(() => desktopReplyPlaybackToken === playbackTokenAtStart).catch((e) =>
        console.warn('Voice barge-in monitor failed:', e.message),
      );
    }
```

Place this at the point where a chunk's audio has just started (`src.start()` or equivalent) — check the exact current shape of `playDecodedChunk` before inserting, since it may have changed since this plan was written.

- [ ] **Step 3: Manual verification**

Use the `run` skill to start `desktop-client` with `MANA_BARGE_IN_VOICE=1` (or confirm it's on by default per the constant above). Trigger a reply, and while it's playing, speak continuously for over 350ms. Confirm playback stops. Confirm a single short sound (a cough, a tap) does *not* stop playback (the hold-duration gate).

- [ ] **Step 4: Commit**

```bash
git add desktop-client/renderer/renderer.js
git commit -m "Add barge-in monitor to desktop-client (stop-and-discard, matches windows-launcher)"
```

---

## Task 4: Settings — autostart preference

**Files:**
- Modify: `desktop-client/renderer/index_fixed.html` (new Voice settings section)
- Modify: `desktop-client/renderer/renderer.js` (localStorage-backed preference, wire into `init()`)

**Interfaces:**
- Consumes: `startListening()` from Task 2.
- Consumes: the existing `localStorage`-preference pattern already used for theme/session/preset (`renderer.js:27-32`, `228`, `1239`).

- [ ] **Step 1: Add the Voice settings section**

In `desktop-client/renderer/index_fixed.html`, add a new `.settings-section` near the existing `#brainProviderSection` (`:205-`), following the same shape but without a hidden-details sub-block (this preference has no sub-fields):

```html
        <div class="settings-section" id="voiceSection">
          <h3>Voice</h3>
          <p class="subtitle">Continuous listening keeps the mic open so you can talk to Mana without pressing a button.</p>
          <label><input type="checkbox" id="listeningAutostartToggle" /> Start listening automatically on launch</label>
        </div>
```

- [ ] **Step 2: Wire the checkbox to `localStorage` and `init()`**

Add near the existing storage-key constants (e.g. alongside `THEME_STORAGE_KEY`, `SESSION_STORAGE_KEY`):

```js
  const LISTENING_AUTOSTART_STORAGE_KEY = 'mana_listening_autostart';
```

Add near the other settings-element lookups (alongside `useRemoteAiToggleEl`):

```js
  const listeningAutostartToggleEl = document.getElementById('listeningAutostartToggle');
  if (listeningAutostartToggleEl) {
    listeningAutostartToggleEl.checked = localStorage.getItem(LISTENING_AUTOSTART_STORAGE_KEY) === '1';
    listeningAutostartToggleEl.addEventListener('change', () => {
      localStorage.setItem(LISTENING_AUTOSTART_STORAGE_KEY, listeningAutostartToggleEl.checked ? '1' : '0');
    });
  }
```

In `init()` (`renderer.js:630-647`), after `setupRecording();`:

```js
    if (localStorage.getItem(LISTENING_AUTOSTART_STORAGE_KEY) === '1') {
      startListening();
    }
```

- [ ] **Step 3: Manual verification**

Use the `run` skill. Confirm the checkbox is unchecked by default on a fresh profile. Check it, restart the app, confirm continuous listening starts automatically (button shows "Stop Listening", status reflects the listening state). Uncheck it, restart, confirm it does not autostart.

- [ ] **Step 4: Commit**

```bash
git add desktop-client/renderer/index_fixed.html desktop-client/renderer/renderer.js
git commit -m "Add autostart-listening preference to desktop-client Settings"
```

---

## Self-Review Notes

- **Spec coverage:** Ported files (spec's "Files to create") → Task 1. `ensureMediaStream`/`recordUntilSilence`/`listenLoop` → Task 2. `watchForBargeIn`-equivalent → Task 3. `#btnListen` UI + status text → Task 2. Voice settings section + autostart (default off) → Task 4. Mic-permission lifecycle → confirmed already in place in `desktop-client/main.js`, no task needed (noted in Global Constraints). Typing/push-to-talk independence → preserved by construction (Task 2's `recordUntilSilence` uses local, not shared, recorder state; `handleVoiceTurn` extraction doesn't touch `sendTextMessage`). VAD RMS-fallback-on-failure → ported as part of Task 2 Step 4's `isSpeechNow()`, matching the confirmed windows-launcher behavior.
- **Placeholder scan:** Task 2 Step 5 and Task 3 Step 2 both explicitly flag a piece of shown code as illustrative/needing verification against the real current file (the playback-active check, and the exact `playDecodedChunk` call site) rather than presenting unverified guesses as fact — this is a deliberate, flagged exception per the same reasoning the streaming-voice-reply plan used for its own test-harness uncertainty, not a silent placeholder. Every other step has concrete, complete code.
- **Type consistency:** `handleVoiceTurn(blob)` (Task 2) is called identically from `onRecordingStop` and `listenLoop`. `watchForBargeIn(isStillPlaying)` (Task 3) takes a callback consistent with how Task 2's playback-state check works, not a direct variable reference (differs intentionally from windows-launcher's version, documented inline). `nextBargeInState`/`shouldStopRecording` signatures match Task 1's ported module exactly, used identically to the reference implementation.
