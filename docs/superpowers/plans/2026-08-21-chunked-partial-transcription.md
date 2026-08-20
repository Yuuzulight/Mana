# Chunked Partial Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give both apps a live, periodically-updated partial transcript while the user is still speaking, via a new async whisper-invocation path and a renderer-side poll — the foundational piece #341's semantic end-of-turn classifier will consume later (Sub-project B, not in this plan).

**Architecture:** A new async whisper-cli invocation (separate function, not a rewrite of the existing synchronous one — see Global Constraints) backs a new `POST /transcribe-partial` endpoint. Both apps' `recordUntilSilence` gain a second timer that snapshots the audio recorded so far, polls the new endpoint, and updates the existing live status text with the result. A failed or slow poll is silently skipped and never affects the actual recording/stop-detection logic.

**Tech Stack:** Node's built-in `node:test` and `node:child_process` (backend), vanilla JS Electron renderers (no new automated coverage for the renderer polling loop, matching this codebase's established precedent for `recordUntilSilence`'s own timing logic).

**Spec:** [docs/superpowers/specs/2026-08-21-chunked-partial-transcription-design.md](../specs/2026-08-21-chunked-partial-transcription-design.md)

## Global Constraints

- **Deviation from the spec, decided during planning — read before starting Task 1:** the spec's own wording ("convert `runWhisperCli`'s `spawnSync` to async spawn") implied converting the *existing* function in place. Planning-time investigation found `runWhisper`/`runWhisperCli` are shared by far more callers than the spec anticipated: `/transcribe-only`, `/transcribe`, `mobile-routes.js`, and — critically — `memory-inbox.js`, which has a comment at `node-bot/memory-inbox.js:64` reading `// options.runWhisper: required, (filePath) => string (whisper.cpp is sync).` — an explicit, documented assumption that calling it does NOT need `await`. Converting the shared function in place risks silently breaking that caller (it would receive a `Promise` object instead of a string, with no error — just wrong behavior) and several test mocks that assume synchronous string returns. **This plan does NOT touch `runWhisperCli`, `runWhisper`, or any of their existing callers.** Instead, it adds a new, separate async function and a new route, used only by the new partial-transcript polling path. This is a narrower, safer scope than the spec's literal wording, not a different design — the underlying goal (an async whisper call safe to poll repeatedly) is unchanged.
- Partial polls reuse the same auto-detected `WHISPER_MODEL` as final transcription (per spec) — confirmed by benchmark (see below) to comfortably keep up with a ~1.2s poll interval; no new model file.
- Benchmark run during brainstorming (3-4 samples each, `tools/whisper/Release/whisper-cli.exe` vs `parakeet-cli.exe -ng`, against real fixtures in `node-bot/tmp/`): whisper-cli averaged 1.13s on a ~5.6s clip and 1.68s on a ~62s clip; parakeet-cli (CPU) averaged 1.92s and 3.24s respectively — consistently ~1.7-2x slower. This is why partial polls use whisper-cli, not Parakeet.
- A failed, slow, or in-flight partial poll must never block, delay, or otherwise affect `recordUntilSilence`'s actual stop-detection logic (`shouldStopRecording`/the VAD tick loop) — the poll is a side channel, not a dependency.

---

## File Structure

- **Modify** `node-bot/server.js` — add `spawn` to the existing `child_process` import, add a new async whisper-invocation function, wire it into the `registerCoreRoutes` deps object.
- **Modify** `node-bot/server-routes.js` — destructure the new dep, add the `POST /transcribe-partial` route.
- **Create** `node-bot/test/transcribe-partial-route.test.js`.
- **Modify** `windows-launcher/renderer/renderer.js` — add periodic partial-poll timer inside `recordUntilSilence`.
- **Modify** `desktop-client/renderer/renderer.js` — same, mirrored.

---

## Task 1: Backend — async whisper invocation + `/transcribe-partial`

**Files:**
- Modify: `node-bot/server.js`
- Modify: `node-bot/server-routes.js`
- Test: `node-bot/test/transcribe-partial-route.test.js`

**Interfaces:**
- Produces: `runWhisperCliPartial(filePath) -> Promise<string>` — an async, non-blocking whisper-cli invocation. Not exported/shared beyond this route; a separate function from the existing synchronous `runWhisperCli`.
- Produces: `POST /transcribe-partial` — multipart upload (`file` field), returns `{transcript: string}` on success (200) or `{error: string}` on failure (400 for a missing file, 500 for a whisper failure) — matches `/transcribe-only`'s exact response shape, consumed by Tasks 2/3's renderer polling code.

Before writing code, re-read `node-bot/server.js` around the existing `runWhisperCli` function (grep for `function runWhisperCli`) and `node-bot/server-routes.js` around `/transcribe-only` (grep for `app.post("/transcribe-only"`) and the `registerCoreRoutes` function's destructuring block (top of the file) — this plan's line numbers are accurate as of this plan's writing but may have drifted.

- [ ] **Step 1: Write the failing test**

```js
const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const fs = require("node:fs");

const { createApp } = require("../server");
const { withServer } = require("./helpers");

test("POST /transcribe-partial returns a transcript for a valid upload", async () => {
  const app = createApp({
    runWhisperPartial: async (filePath) => {
      assert.ok(filePath, "should receive a file path");
      return "partial transcript text";
    },
  });

  await withServer(app, async (baseUrl) => {
    const form = new FormData();
    // A tiny valid WAV header is enough -- runWhisperPartial is mocked
    // above and never actually reads this file's audio content.
    const wavBytes = Buffer.from(
      "52494646244000005741564566" + "6d7420100000000100010080" + "3e0000807d000002001000" + "6461746100000000",
      "hex",
    );
    form.append("file", new Blob([wavBytes]), "test.wav");

    const response = await fetch(`${baseUrl}/transcribe-partial`, {
      method: "POST",
      body: form,
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.transcript, "partial transcript text");
  });
});

test("POST /transcribe-partial rejects a request with no file", async () => {
  const app = createApp({
    runWhisperPartial: async () => "unused",
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/transcribe-partial`, {
      method: "POST",
      body: new FormData(),
    });

    assert.equal(response.status, 400);
  });
});

test("POST /transcribe-partial returns 500 if the whisper call throws", async () => {
  const app = createApp({
    runWhisperPartial: async () => {
      throw new Error("whisper (partial) failed: boom");
    },
  });

  await withServer(app, async (baseUrl) => {
    const form = new FormData();
    const wavBytes = Buffer.from(
      "52494646244000005741564566" + "6d7420100000000100010080" + "3e0000807d000002001000" + "6461746100000000",
      "hex",
    );
    form.append("file", new Blob([wavBytes]), "test.wav");

    const response = await fetch(`${baseUrl}/transcribe-partial`, {
      method: "POST",
      body: form,
    });

    assert.equal(response.status, 500);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd node-bot && node --test test/transcribe-partial-route.test.js`
Expected: FAIL with a 404 (route doesn't exist yet) or a `createApp` dependency-injection error (`runWhisperPartial` unused/unknown) — either confirms the route isn't wired yet.

- [ ] **Step 3: Add `spawn` to the existing import**

In `node-bot/server.js`, find the existing line:

```js
const { spawnSync } = require("child_process");
```

Replace with:

```js
const { spawnSync, spawn } = require("child_process");
```

- [ ] **Step 4: Add `runWhisperCliPartial`, right after the existing `runWhisperCli` function**

```js
  // Runs whisper-cli asynchronously (spawn, not spawnSync) so it doesn't
  // block the event loop -- unlike runWhisperCli above, this is called
  // repeatedly (every ~1.2s) while the user is still speaking, to produce
  // a live partial transcript. A separate function rather than converting
  // runWhisperCli in place: several existing callers (memory-inbox.js
  // explicitly documents "whisper.cpp is sync") assume the synchronous
  // contract, and converting it would risk silently breaking them.
  function spawnWhisperCliAsync(whisperBin, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(whisperBin, args, { windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({ status: code, stdout, stderr });
      });
    });
  }

  async function runWhisperCliPartial(filePath) {
    const whisperModel = whisperDiscovery.findWhisperModel({ env: process.env });
    if (!whisperModel) {
      throw new Error(
        "Whisper model not found under tools/whisper. Set WHISPER_MODEL to a valid ggml *.bin path.",
      );
    }
    const whisperBin = findWhisperBin();
    const startedAt = nowMs();
    // A distinct suffix from runWhisperCli's ".out" -- self-documents this
    // as the partial-transcription artifact, even though a filename
    // collision isn't actually possible (each upload gets its own tmp path).
    const outBase = filePath + ".partial-out";
    const outJson = outBase + ".json";
    const args = [
      "-m",
      whisperModel,
      "-f",
      filePath,
      "-t",
      String(WHISPER_THREADS),
      "-l",
      WHISPER_LANGUAGE,
      "-bs",
      WHISPER_BEAM_SIZE,
      "-nth",
      WHISPER_NO_SPEECH_THRESHOLD,
      "-tp",
      WHISPER_TEMPERATURE,
      "--output-json",
      "-of",
      outBase,
    ];
    if (WHISPER_PROMPT) {
      args.push("--prompt", WHISPER_PROMPT, "--carry-initial-prompt");
    }
    const r = await spawnWhisperCliAsync(whisperBin, args);
    if (r.status !== 0) {
      console.error("whisper (partial) stderr:", r.stderr);
      throw new Error("whisper (partial) failed: " + r.stderr);
    }
    logPerf("whisper-partial", startedAt);
    // Wait briefly for the JSON file to appear -- async setTimeout, not
    // runWhisperCli's blocking Atomics.wait, since blocking here would
    // defeat the entire point of using spawn over spawnSync.
    let attempts = 0;
    while (!fs.existsSync(outJson) && attempts < 5) {
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!fs.existsSync(outJson)) {
      return r.stdout ? r.stdout.trim() : "";
    }
    try {
      const j = JSON.parse(fs.readFileSync(outJson, "utf8"));
      if (j && j.transcription && j.transcription.length > 0) {
        const t = j.transcription
          .map((s) => s.text)
          .join(" ")
          .trim();
        try {
          fs.unlinkSync(outJson);
        } catch (e) {}
        try {
          fs.unlinkSync(outBase + ".txt");
        } catch (e) {}
        return t;
      }
    } catch (e) {
      console.warn("failed to parse whisper (partial) json", e);
    }
    return r.stdout ? r.stdout.trim() : "";
  }
```

- [ ] **Step 5: Wire `runWhisperPartial` into `registerCoreRoutes`'s deps**

Find the `registerCoreRoutes(app, upload, { ... })` call (grep for `registerCoreRoutes(app, upload,`) and add, next to the existing `runWhisper: deps.runWhisper || runWhisper,` line:

```js
    runWhisperPartial: deps.runWhisperPartial || runWhisperCliPartial,
```

- [ ] **Step 6: Destructure the new dep and add the route in `server-routes.js`**

In `node-bot/server-routes.js`'s `registerCoreRoutes` function, add `runWhisperPartial` to the existing destructuring block (next to `runWhisper`):

```js
    runWhisper,
    runWhisperPartial,
```

Add the new route immediately after the existing `POST /transcribe-only` route:

```js
  app.post("/transcribe-partial", upload.single("file"), async (req, res) => {
    try {
      requireFile(req.file, "file");

      const { tmpPath, audioPath } = normalizeUploadedAudio(req.file);
      const transcript = await runWhisperPartial(audioPath);
      cleanupUploadedAudio(tmpPath, audioPath);

      return res.json({ transcript });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd node-bot && node --test test/transcribe-partial-route.test.js`
Expected: PASS (3 tests)

- [ ] **Step 8: Regression sweep**

Run: `cd node-bot && node --test test/server-routes.test.js test/mobile-routes.test.js test/memory-inbox.test.js`
Expected: PASS, unchanged — confirms `runWhisperCli`/`runWhisper` and their existing callers (`/transcribe-only`, `/transcribe`, mobile routes, memory-inbox) are genuinely untouched by this task.

- [ ] **Step 9: Commit**

```bash
git add node-bot/server.js node-bot/server-routes.js node-bot/test/transcribe-partial-route.test.js
git commit -m "Add async whisper invocation and POST /transcribe-partial (#341 Sub-project A)"
```

---

## Task 2: windows-launcher — periodic partial-transcript polling

**Files:**
- Modify: `windows-launcher/renderer/renderer.js`

**Interfaces:**
- Consumes: `POST /transcribe-partial` (Task 1) — `{transcript: string}` on success.
- Consumes: `BACKEND_BASE_URL`, `SILENCE_METER_INTERVAL_MS` (existing), `statusEl` (existing) — all already in scope within `recordUntilSilence`.

Before editing, re-read the current `recordUntilSilence` function (grep for `async function recordUntilSilence`) to confirm it still matches the shape below — this file has had several rounds of edits already this session.

- [ ] **Step 1: Add the polling constant**

Near the existing `const SILENCE_METER_INTERVAL_MS = 150;`, add:

```js
// #341 Sub-project A: how often to snapshot the audio recorded so far and
// poll for a partial transcript while the user is still speaking. Slower
// than SILENCE_METER_INTERVAL_MS (150ms, the VAD tick) on purpose --
// whisper-cli takes ~1-1.7s per call (benchmarked), so polling faster than
// that would just pile up in-flight requests.
const PARTIAL_TRANSCRIPT_POLL_MS = 1200;
```

- [ ] **Step 2: Add the poll function and wire it into `recordUntilSilence`**

Inside `recordUntilSilence`'s `return await new Promise((resolve, reject) => { ... })` block, find:

```js
    const chunks = [];
    const recorder = new MediaRecorder(mediaStream, { mimeType: "audio/webm" });
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
```

Replace with:

```js
    const chunks = [];
    const recorder = new MediaRecorder(mediaStream, { mimeType: "audio/webm" });
    let hasHeardSpeech = false;
    let lastSpeechAt = 0;
    let meterTimer = null;
    let partialTimer = null;
    let partialPollInFlight = false;
    let stopped = false;
    const startedAt = performance.now();

    function cleanup() {
      stopped = true;
      if (meterTimer !== null) {
        clearTimeout(meterTimer);
        meterTimer = null;
      }
      if (partialTimer !== null) {
        clearInterval(partialTimer);
        partialTimer = null;
      }
      try {
        source.disconnect();
      } catch (e) {}
      audioCtx.close().catch(() => {});
    }

    // #341 Sub-project A: snapshots whatever's been recorded so far and
    // polls for a partial transcript, updating the live status text. A
    // failed or slow poll is silently skipped -- this never blocks or
    // delays tick()'s actual stop-detection logic below. Both this and
    // tick() write statusEl.textContent independently; whichever fires
    // last wins, self-correcting each cycle -- an accepted simplification,
    // not a bug, since this is a live status indicator, not a source of
    // truth for anything.
    async function pollPartialTranscript() {
      if (stopped || partialPollInFlight || chunks.length === 0) {
        return;
      }
      partialPollInFlight = true;
      try {
        const snapshot = new Blob(chunks, { type: "audio/webm" });
        const form = new FormData();
        form.append("file", snapshot, "partial.webm");
        const response = await fetch(`${BACKEND_BASE_URL}/transcribe-partial`, {
          method: "POST",
          body: form,
        });
        if (!response.ok || stopped) {
          return;
        }
        const data = await response.json();
        if (data.transcript && !stopped) {
          statusEl.textContent = `Hearing: "${data.transcript}"`;
        }
      } catch (e) {
        console.warn("Partial transcript poll failed:", e.message);
      } finally {
        partialPollInFlight = false;
      }
    }
```

- [ ] **Step 3: Start the timer alongside the recorder**

Find:

```js
    // A short timeslice keeps dataavailable events flowing so audio isn't
    // lost if recording stops earlier than a browser's default flush cadence.
    recorder.start(SILENCE_METER_INTERVAL_MS);
```

Replace with:

```js
    // A short timeslice keeps dataavailable events flowing so audio isn't
    // lost if recording stops earlier than a browser's default flush cadence.
    recorder.start(SILENCE_METER_INTERVAL_MS);
    partialTimer = setInterval(pollPartialTranscript, PARTIAL_TRANSCRIPT_POLL_MS);
```

- [ ] **Step 4: Manual verification**

Use the `run` skill to start `windows-launcher`. Speak a longer sentence (5+ seconds) and confirm the status text updates to show a "Hearing: ..." partial transcript roughly once per second while still speaking, before the recording stops. Confirm a normal short utterance still works end-to-end (transcribed, replied to) exactly as before — this task must not change `recordUntilSilence`'s actual behavior, only add a side-channel status update.

- [ ] **Step 5: Commit**

```bash
git add windows-launcher/renderer/renderer.js
git commit -m "Add partial-transcript polling to windows-launcher (#341 Sub-project A)"
```

---

## Task 3: desktop-client — periodic partial-transcript polling

**Files:**
- Modify: `desktop-client/renderer/renderer.js`

**Interfaces:** mirrors Task 2, adapted to this app's `localChunks`/`localRecorder` naming and hardcoded `http://127.0.0.1:5005` base URL (this app does not use a `BACKEND_BASE_URL` variable, unlike windows-launcher — matches the existing pattern already used by this app's `/barge-in/classify` fetch call).

Before editing, re-read the current `recordUntilSilence` function (grep for `async function recordUntilSilence`) to confirm it still matches the shape below.

- [ ] **Step 1: Add the polling constant**

Near the existing `const SILENCE_METER_INTERVAL_MS = 150;`, add:

```js
  // #341 Sub-project A: how often to snapshot the audio recorded so far
  // and poll for a partial transcript while the user is still speaking.
  const PARTIAL_TRANSCRIPT_POLL_MS = 1200;
```

- [ ] **Step 2: Add the poll function and wire it into `recordUntilSilence`**

Inside `recordUntilSilence`'s `return await new Promise((resolve, reject) => { ... })` block, find:

```js
      const localChunks = [];
      const localRecorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm' });
      let hasHeardSpeech = false;
      let lastSpeechAt = 0;
      let meterTimer = null;
      let stopped = false;
      let noSpeechResult = false;
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
```

Replace with:

```js
      const localChunks = [];
      const localRecorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm' });
      let hasHeardSpeech = false;
      let lastSpeechAt = 0;
      let meterTimer = null;
      let partialTimer = null;
      let partialPollInFlight = false;
      let stopped = false;
      let noSpeechResult = false;
      const startedAt = performance.now();

      function cleanup() {
        stopped = true;
        if (meterTimer !== null) {
          clearTimeout(meterTimer);
          meterTimer = null;
        }
        if (partialTimer !== null) {
          clearInterval(partialTimer);
          partialTimer = null;
        }
        try {
          source.disconnect();
        } catch (e) {}
        audioCtx.close().catch(() => {});
      }

      // #341 Sub-project A: snapshots whatever's been recorded so far and
      // polls for a partial transcript, updating the live status text. A
      // failed or slow poll is silently skipped -- never blocks or delays
      // tick()'s actual stop-detection logic below.
      async function pollPartialTranscript() {
        if (stopped || partialPollInFlight || localChunks.length === 0) {
          return;
        }
        partialPollInFlight = true;
        try {
          const snapshot = new Blob(localChunks, { type: 'audio/webm' });
          const form = new FormData();
          form.append('file', snapshot, 'partial.webm');
          const response = await fetch('http://127.0.0.1:5005/transcribe-partial', {
            method: 'POST',
            body: form,
          });
          if (!response.ok || stopped) {
            return;
          }
          const data = await response.json();
          if (data.transcript && !stopped) {
            statusEl.textContent = `Hearing: "${data.transcript}"`;
          }
        } catch (e) {
          console.warn('Partial transcript poll failed:', e.message);
        } finally {
          partialPollInFlight = false;
        }
      }
```

- [ ] **Step 3: Start the timer alongside the recorder**

Find:

```js
      localRecorder.start(SILENCE_METER_INTERVAL_MS);
```

Replace with:

```js
      localRecorder.start(SILENCE_METER_INTERVAL_MS);
      partialTimer = setInterval(pollPartialTranscript, PARTIAL_TRANSCRIPT_POLL_MS);
```

- [ ] **Step 4: Manual verification**

Same as Task 2 Step 4, run against `desktop-client`.

- [ ] **Step 5: Commit**

```bash
git add desktop-client/renderer/renderer.js
git commit -m "Add partial-transcript polling to desktop-client (#341 Sub-project A)"
```

---

## Self-Review Notes

- **Spec coverage:** Async whisper invocation → Task 1 (via a new, separate function per the Global Constraints deviation, not a rewrite of the existing one — deviation explained and justified there). `POST /transcribe-partial` → Task 1. Renderer periodic snapshot-and-poll → Tasks 2/3. Live status text as the visible deliverable → Tasks 2/3 Step 2. Benchmark justifying whisper-cli over Parakeet → Global Constraints, cites the actual numbers. "Never blocks the actual recording logic" requirement → satisfied by construction in both apps (the poll function is entirely independent of `tick()`/`shouldStopRecording`, guarded by its own `partialPollInFlight` flag, and a failed poll only logs a warning).
- **Placeholder scan:** every step has complete, concrete code, copied from or diffed against the actual current files read fresh during this plan's authoring. No TBD/TODO. The two "before editing, re-read the current file" notes are explicit verification checkpoints against a live-evolving file, matching established precedent from prior plans in this session, not placeholders.
- **Type consistency:** `runWhisperCliPartial(filePath) -> Promise<string>` (Task 1) is consumed identically by the route handler (`await runWhisperPartial(audioPath)`) and by the test's mock (`async (filePath) => "..."`, matching the real signature). `POST /transcribe-partial`'s `{transcript: string}` response shape is read identically in both apps' `pollPartialTranscript()` (`data.transcript`). `PARTIAL_TRANSCRIPT_POLL_MS = 1200` and the `pollPartialTranscript`/`partialTimer`/`partialPollInFlight` naming are identical across Tasks 2 and 3, differing only in each app's own chunk-array name (`chunks` vs `localChunks`) and base URL convention (`BACKEND_BASE_URL` vs the hardcoded `127.0.0.1:5005`), both pre-existing, unchanged conventions.
