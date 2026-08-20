# Barge-in Interruption Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace today's stop-and-discard barge-in behavior in both apps with stop → hold → classify → resume/discard/insert, plus the missing energy/loudness signal (#340) that gates the existing VAD hold-timer.

**Architecture:** A new backend classifier (`node-bot/utils/barge-in-classifier.js`) and endpoint (`POST /barge-in/classify`) sort a transcribed interruption into `backchannel` / `correction` / `new_question` / `unclassified`. Each app's `voice-endpointing.js` gains a loudness gate on the existing VAD hold-timer. Each app's `renderer.js` gains: a `peekPending()`-based capture of the streaming-chunk-queue's not-yet-played sentences at trigger time, a dedicated immediate recording of the interruption (bypassing the normal listen loop), and a resume/discard/insert dispatcher built on the existing chunk-queue/playback primitives — no new playback primitive, no LLM-generation abort.

**Tech Stack:** Node's built-in `node:test`, Express (`node-bot/server.js`), vanilla JS Electron renderers (`windows-launcher`, `desktop-client`), `onnxruntime-web`/Silero VAD (already in place from Sub-project A).

**Spec:** [docs/superpowers/specs/2026-08-20-barge-in-interruption-handling-design.md](../specs/2026-08-20-barge-in-interruption-handling-design.md)

## Global Constraints

- LLM generation is never aborted by any of this — only already-generated reply *text*/*playback* is held, resumed, or discarded. No `AbortController` wiring.
- Held state is text only (the streaming-chunk-queue's not-yet-played sentences) — never cached audio. Resume re-synthesizes.
- Held state never nests beyond depth 1: a second interruption while an inserted new-question answer is playing discards the outer held reply and is handled as a fresh top-level turn, no classification needed for that case.
- `voice-endpointing.js` and `streaming-chunk-queue.js` stay separate per-app copies (established convention, reaffirmed in Sub-project A's plan) — no cross-app shared module.
- The non-streaming `playReplyAudio`/`speakReply` fallback paths (used only when a streamed draft turns out stale) keep today's stop-and-discard behavior — hold/resume only applies to the live streaming path, matching the spec's "streaming-chunk-queue's not-yet-played sentences" wording.

---

## File Structure

- **Create** `node-bot/utils/barge-in-classifier.js` — `classifyBargeIn(text)`.
- **Create** `node-bot/test/barge-in-classifier.test.js`.
- **Modify** `node-bot/server.js` — add `POST /barge-in/classify`.
- **Create** `node-bot/test/barge-in-classify-route.test.js`.
- **Modify** `windows-launcher/renderer/voice-endpointing.js` — `isLoudEnough` param, `DEFAULT_BARGE_IN_MIN_DBFS`, `dbfsFromSamples`.
- **Modify** `windows-launcher/test/voice-endpointing.test.js`.
- **Modify** `desktop-client/renderer/voice-endpointing.js` — mirror.
- **Modify** `desktop-client/test/voice-endpointing.test.js` — mirror.
- **Modify** `windows-launcher/renderer/renderer.js` — wire the loudness gate into `watchForBargeIn`.
- **Modify** `desktop-client/renderer/renderer.js` — mirror.
- **Modify** `windows-launcher/renderer/streaming-chunk-queue.js` — `peekPending()`.
- **Modify** `windows-launcher/test/streaming-chunk-queue.test.js`.
- **Modify** `desktop-client/renderer/streaming-chunk-queue.js` — mirror.
- **Modify** `desktop-client/test/streaming-chunk-queue.test.js` — mirror.
- **Modify** `windows-launcher/renderer/renderer.js` — held-state capture/resume/discard/insert.
- **Modify** `desktop-client/renderer/renderer.js` — mirror, plus extracting `transcribeBlob`/`handleTranscriptText` from `handleVoiceTurn`.

---

## Task 1: Backend classifier

**Files:**
- Create: `node-bot/utils/barge-in-classifier.js`
- Test: `node-bot/test/barge-in-classifier.test.js`

**Interfaces:**
- Produces: `classifyBargeIn(text) -> { category: 'backchannel'|'correction'|'new_question'|'unclassified', reason: string }` — consumed by Task 2's route and, indirectly, by Tasks 5/6's renderer code (via the route).

- [ ] **Step 1: Write the failing tests**

```js
const assert = require("node:assert/strict");
const test = require("node:test");

const { classifyBargeIn } = require("../utils/barge-in-classifier");

test("correction/stop keywords win even inside a longer sentence", () => {
  assert.equal(classifyBargeIn("wait, that's not what I meant").category, "correction");
  assert.equal(classifyBargeIn("no no stop").category, "correction");
  assert.equal(classifyBargeIn("actually never mind").category, "correction");
  assert.equal(classifyBargeIn("hold on a second").category, "correction");
});

test("question words or a trailing question mark classify as new_question", () => {
  assert.equal(classifyBargeIn("what time is it").category, "new_question");
  assert.equal(classifyBargeIn("can you check the weather").category, "new_question");
  assert.equal(classifyBargeIn("is that true?").category, "new_question");
  assert.equal(classifyBargeIn("how do I do that").category, "new_question");
});

test("short acknowledgements classify as backchannel", () => {
  assert.equal(classifyBargeIn("mhm").category, "backchannel");
  assert.equal(classifyBargeIn("yeah okay").category, "backchannel");
  assert.equal(classifyBargeIn("got it, cool").category, "backchannel");
});

test("anything else, including empty input, falls back to unclassified", () => {
  assert.equal(classifyBargeIn("").category, "unclassified");
  assert.equal(classifyBargeIn("banana pancakes").category, "unclassified");
  assert.equal(classifyBargeIn(undefined).category, "unclassified");
});

test("correction keywords are checked before question/backchannel keywords", () => {
  // Contains a question word ("is") AND a correction keyword ("wait") --
  // correction must win, since it's the fast-path checked first.
  assert.equal(classifyBargeIn("wait is that right").category, "correction");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd node-bot && node --test test/barge-in-classifier.test.js`
Expected: FAIL with "Cannot find module '../utils/barge-in-classifier'"

- [ ] **Step 3: Write the implementation**

```js
/**
 * Classifies a transcribed barge-in interruption so the caller can decide
 * whether to resume the reply that was cut off, discard it, or answer the
 * interruption and then resume. Matches intent-classifier.js's style:
 * ordered keyword lists, .includes() checks, explicit fallback.
 *
 * @param {string} text
 * @returns {{ category: 'backchannel'|'correction'|'new_question'|'unclassified', reason: string }}
 */
function classifyBargeIn(text) {
  if (!text || typeof text !== "string") {
    return { category: "unclassified", reason: "empty_or_invalid_input" };
  }
  const textLower = text.toLowerCase().trim();

  // 1. Correction/stop keywords -- checked first (fast-path) so a sentence
  // that also happens to contain a question word ("wait, is that right")
  // still stops the reply instead of being treated as a new question.
  const correctionKeywords = [
    "wait",
    "stop",
    "hold on",
    "no",
    "nevermind",
    "never mind",
    "actually",
  ];
  const matchedCorrection = correctionKeywords.find((keyword) => textLower.includes(keyword));
  if (matchedCorrection) {
    return { category: "correction", reason: `matched_correction_keyword (${matchedCorrection})` };
  }

  // 2. New-question heuristic: starts with a question word, or ends in "?".
  const questionWords = [
    "what",
    "why",
    "how",
    "when",
    "where",
    "who",
    "can",
    "could",
    "do",
    "does",
    "is",
    "are",
  ];
  const firstWord = textLower.split(/\s+/)[0];
  if (questionWords.includes(firstWord) || textLower.endsWith("?")) {
    return { category: "new_question", reason: "question_shape" };
  }

  // 3. Backchannel keywords.
  const backchannelKeywords = [
    "mhm",
    "yeah",
    "okay",
    "ok",
    "right",
    "uh huh",
    "got it",
    "sure",
    "cool",
  ];
  const matchedBackchannel = backchannelKeywords.find((keyword) => textLower.includes(keyword));
  if (matchedBackchannel) {
    return { category: "backchannel", reason: `matched_backchannel_keyword (${matchedBackchannel})` };
  }

  // 4. Default.
  return { category: "unclassified", reason: "default_fallback" };
}

module.exports = { classifyBargeIn };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd node-bot && node --test test/barge-in-classifier.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add node-bot/utils/barge-in-classifier.js node-bot/test/barge-in-classifier.test.js
git commit -m "Add barge-in interruption classifier (backchannel/correction/new_question/unclassified)"
```

---

## Task 2: Backend endpoint

**Files:**
- Modify: `node-bot/server.js`
- Test: `node-bot/test/barge-in-classify-route.test.js`

**Interfaces:**
- Consumes: `classifyBargeIn(text)` from Task 1.
- Produces: `POST /barge-in/classify` — `{text: string} -> {success, category, reason, input_length}` (200) or `{success:false, error, message}` (400) — consumed by Tasks 5/6's renderer code.

Before writing code, re-read `node-bot/server.js` around the existing `POST /debug/intent` route (currently ~line 2486) to confirm its exact current shape and line number before inserting the new route right after it — the two routes should sit together since they're both "classify user text and return the category" endpoints.

- [ ] **Step 1: Write the failing test**

```js
const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");
const { withServer } = require("./helpers");

test("POST /barge-in/classify returns a category for valid text", async () => {
  const app = createApp();

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/barge-in/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "wait, hold on" }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.category, "correction");
    assert.equal(typeof body.reason, "string");
    assert.equal(body.input_length, "wait, hold on".length);
  });
});

test("POST /barge-in/classify rejects a missing text field", async () => {
  const app = createApp();

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/barge-in/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.success, false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd node-bot && node --test test/barge-in-classify-route.test.js`
Expected: FAIL with a 404 (route doesn't exist yet)

- [ ] **Step 3: Add the route**

In `server.js`, immediately after the `POST /debug/intent` route:

```js
  app.post("/barge-in/classify", (req, res) => {
    const { text } = req.body || {};
    if (text === undefined || typeof text !== "string") {
      return res.status(400).json({
        success: false,
        error: "Bad Request",
        message:
          "Missing or invalid 'text' property in the JSON body payload.",
      });
    }

    try {
      const { classifyBargeIn } = require("./utils/barge-in-classifier");
      const evaluation = classifyBargeIn(text);
      return res.status(200).json(
        Object.assign(
          {
            success: true,
            input_length: text.length,
          },
          evaluation,
        ),
      );
    } catch (err) {
      console.error(
        "🚨 [/barge-in/classify] Router checkpoint failed:",
        err?.message || err,
      );
      return res.status(500).json({
        success: false,
        error: "Internal Server Error",
      });
    }
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd node-bot && node --test test/barge-in-classify-route.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add node-bot/server.js node-bot/test/barge-in-classify-route.test.js
git commit -m "Add POST /barge-in/classify endpoint"
```

---

## Task 3: windows-launcher — energy/loudness gate (#340)

**Files:**
- Modify: `windows-launcher/renderer/voice-endpointing.js`
- Modify: `windows-launcher/renderer/renderer.js` (wire into `watchForBargeIn`)
- Test: `windows-launcher/test/voice-endpointing.test.js`

**Interfaces:**
- Produces: `nextBargeInState({..., isLoudEnough = true})` — the hold countdown now only starts/continues when `isSpeech && isLoudEnough`. Default `true` keeps every existing caller's behavior unchanged.
- Produces: `dbfsFromSamples(samples: Float32Array) -> number` and `DEFAULT_BARGE_IN_MIN_DBFS = -45`.

- [ ] **Step 1: Write the failing tests**

Add to `windows-launcher/test/voice-endpointing.test.js`, after the existing `nextBargeInState` tests, and add `DEFAULT_BARGE_IN_MIN_DBFS`/`dbfsFromSamples` to the top `require`:

```js
const {
  DEFAULT_BARGE_IN_HOLD_MS,
  DEFAULT_BARGE_IN_MIN_DBFS,
  DEFAULT_MAX_UTTERANCE_MS,
  DEFAULT_MAX_WAIT_FOR_SPEECH_MS,
  DEFAULT_SILENCE_BUFFER_MS,
  dbfsFromSamples,
  nextBargeInState,
  shouldStopRecording,
} = require("../renderer/voice-endpointing");
```

```js
test("nextBargeInState does not start the hold timer on quiet speech-shaped noise", () => {
  const state = nextBargeInState({
    isSpeech: true,
    isLoudEnough: false,
    speechStartedAt: null,
    now: 1000,
  });
  assert.equal(state.triggered, false);
  assert.equal(state.speechStartedAt, null);
});

test("nextBargeInState resets an in-progress hold if a frame drops below the loudness floor", () => {
  const first = nextBargeInState({ isSpeech: true, isLoudEnough: true, speechStartedAt: null, now: 1000 });
  const quiet = nextBargeInState({
    isSpeech: true,
    isLoudEnough: false,
    speechStartedAt: first.speechStartedAt,
    now: 1100,
  });
  assert.equal(quiet.speechStartedAt, null);
  assert.equal(quiet.triggered, false);
});

test("nextBargeInState's isLoudEnough defaults to true (existing callers unaffected)", () => {
  const first = nextBargeInState({ isSpeech: true, speechStartedAt: null, now: 1000 });
  const triggered = nextBargeInState({
    isSpeech: true,
    speechStartedAt: first.speechStartedAt,
    now: 1000 + DEFAULT_BARGE_IN_HOLD_MS,
  });
  assert.equal(triggered.triggered, true);
});

test("dbfsFromSamples reads full-scale as 0 dBFS and silence as -Infinity", () => {
  const loud = new Float32Array(4).fill(1);
  assert.equal(dbfsFromSamples(loud), 0);

  const silent = new Float32Array(4).fill(0);
  assert.equal(dbfsFromSamples(silent), -Infinity);
});

test("dbfsFromSamples ranks a quieter buffer below a louder one", () => {
  const quiet = new Float32Array(4).fill(0.01);
  const loud = new Float32Array(4).fill(0.5);
  assert.ok(dbfsFromSamples(quiet) < dbfsFromSamples(loud));
});

test("DEFAULT_BARGE_IN_MIN_DBFS sits between typical room noise and speech level", () => {
  assert.ok(DEFAULT_BARGE_IN_MIN_DBFS < -20 && DEFAULT_BARGE_IN_MIN_DBFS > -60);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd windows-launcher && node --test test/voice-endpointing.test.js`
Expected: FAIL (`dbfsFromSamples`/`DEFAULT_BARGE_IN_MIN_DBFS` undefined, `isLoudEnough` cases not yet respected)

- [ ] **Step 3: Implement in `voice-endpointing.js`**

Replace the existing `nextBargeInState` function and its surrounding constant with:

```js
const DEFAULT_BARGE_IN_HOLD_MS = 350;

// #340: below this loudness, a frame doesn't count toward the barge-in hold
// timer even if VAD says it's speech -- filters out quiet room noise/breath
// that Silero VAD sometimes false-positives on. -45 dBFS sits above typical
// mic room-noise floor (-50 to -60 dBFS) and below normal speech level (-20
// to -30 dBFS); tunable via this exported constant without redeploying.
const DEFAULT_BARGE_IN_MIN_DBFS = -45;

function nextBargeInState({
  isSpeech,
  speechStartedAt,
  now,
  holdMs = DEFAULT_BARGE_IN_HOLD_MS,
  isLoudEnough = true,
}) {
  if (!isSpeech || !isLoudEnough) {
    return { speechStartedAt: null, triggered: false };
  }
  const startedAt = speechStartedAt === null ? now : speechStartedAt;
  return { speechStartedAt: startedAt, triggered: now - startedAt >= holdMs };
}

// #340: converts a Float32Array time-domain buffer (the same kind
// analyser.getFloatTimeDomainData already fills for the VAD frame) into a
// loudness reading in dBFS -- 0 is full scale, more negative is quieter.
// Same RMS computation recordUntilSilence's currentRms() already does,
// just expressed logarithmically so it can be compared against
// DEFAULT_BARGE_IN_MIN_DBFS.
function dbfsFromSamples(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    sum += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sum / samples.length);
  return 20 * Math.log10(rms);
}
```

Update the `module.exports` block:

```js
module.exports = {
  DEFAULT_BARGE_IN_HOLD_MS,
  DEFAULT_BARGE_IN_MIN_DBFS,
  DEFAULT_GAMING_MAX_WAIT_FOR_SPEECH_MS,
  DEFAULT_MAX_UTTERANCE_MS,
  DEFAULT_MAX_WAIT_FOR_SPEECH_MS,
  DEFAULT_SILENCE_BUFFER_MS,
  dbfsFromSamples,
  nextBargeInState,
  shouldStopRecording,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd windows-launcher && node --test test/voice-endpointing.test.js`
Expected: PASS (all tests, existing + 6 new)

- [ ] **Step 5: Wire the loudness gate into `watchForBargeIn`**

Before editing, re-read the current `watchForBargeIn` in `windows-launcher/renderer/renderer.js` (~line 1143-1206) to confirm it still matches the shape below.

Add near the existing `BARGE_IN_HOLD_MS`/`BARGE_IN_POLL_MS` constants:

```js
const BARGE_IN_MIN_DBFS = Number(process.env.MANA_BARGE_IN_MIN_DBFS || DEFAULT_BARGE_IN_MIN_DBFS);
```

Add `DEFAULT_BARGE_IN_MIN_DBFS` and `dbfsFromSamples` to the existing `require("./voice-endpointing")` destructure at the top of the file.

In `watchForBargeIn`, replace:

```js
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
```

with:

```js
        let isSpeech = false;
        try {
          analyser.getFloatTimeDomainData(samples);
          const frame = samples.subarray(samples.length - VAD_FRAME_SAMPLES);
          const probability = await vad.processFrame(frame);
          isSpeech = vad.isSpeech(probability);
        } catch (e) {
          isSpeech = false;
        }

        // #340: reuses the same `samples` frame just read for VAD -- no
        // extra mic read.
        const isLoudEnough = dbfsFromSamples(samples) >= BARGE_IN_MIN_DBFS;

        const state = nextBargeInState({
          isSpeech,
          isLoudEnough,
          speechStartedAt,
          now: performance.now(),
          holdMs: BARGE_IN_HOLD_MS,
        });
```

- [ ] **Step 6: Manual verification**

Use the `run` skill to start `windows-launcher`. Trigger a reply, and while it's playing, breathe/tap near the mic without speaking clearly — confirm this does *not* trigger barge-in (it wouldn't have before this change either, but confirm no regression). Speak normally and continuously for over 350ms — confirm barge-in still triggers as before.

- [ ] **Step 7: Commit**

```bash
git add windows-launcher/renderer/voice-endpointing.js windows-launcher/renderer/renderer.js windows-launcher/test/voice-endpointing.test.js
git commit -m "Add energy/loudness gate to windows-launcher's barge-in hold timer (#340)"
```

---

## Task 4: desktop-client — energy/loudness gate (#340)

**Files:**
- Modify: `desktop-client/renderer/voice-endpointing.js`
- Modify: `desktop-client/renderer/renderer.js` (wire into `watchForBargeIn`)
- Test: `desktop-client/test/voice-endpointing.test.js`

**Interfaces:** identical to Task 3, mirrored into `desktop-client`'s copy of the file.

- [ ] **Step 1: Apply Task 3 Steps 1-4 verbatim to `desktop-client`**

`desktop-client/renderer/voice-endpointing.js` and `desktop-client/test/voice-endpointing.test.js` are currently byte-identical to `windows-launcher`'s copies (ported verbatim in Sub-project A). Apply the exact same test additions and implementation change from Task 3 Steps 1-4 to these files.

Run: `cd desktop-client && node --test test/voice-endpointing.test.js`
Expected: PASS (all tests, existing + 6 new)

- [ ] **Step 2: Wire the loudness gate into `watchForBargeIn`**

Before editing, re-read the current `watchForBargeIn` in `desktop-client/renderer/renderer.js` (~line 673-736) to confirm it still matches the shape below — note this app's version takes `(isStillPlaying, onTrigger)` params, unlike `windows-launcher`'s.

Add near the existing `BARGE_IN_HOLD_MS`/`BARGE_IN_POLL_MS` constants:

```js
const BARGE_IN_MIN_DBFS = Number(process.env.MANA_BARGE_IN_MIN_DBFS || DEFAULT_BARGE_IN_MIN_DBFS);
```

Add `DEFAULT_BARGE_IN_MIN_DBFS` and `dbfsFromSamples` to the existing `require("./voice-endpointing")` destructure.

In `watchForBargeIn`, replace:

```js
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
```

with:

```js
          let isSpeech = false;
          try {
            analyser.getFloatTimeDomainData(samples);
            const frame = samples.subarray(samples.length - VAD_FRAME_SAMPLES);
            const probability = await vad.processFrame(frame);
            isSpeech = vad.isSpeech(probability);
          } catch (e) {
            isSpeech = false;
          }

          const isLoudEnough = dbfsFromSamples(samples) >= BARGE_IN_MIN_DBFS;

          const state = nextBargeInState({
            isSpeech,
            isLoudEnough,
            speechStartedAt,
            now: performance.now(),
            holdMs: BARGE_IN_HOLD_MS,
          });
```

- [ ] **Step 3: Manual verification**

Same as Task 3 Step 6, run against `desktop-client`.

- [ ] **Step 4: Commit**

```bash
git add desktop-client/renderer/voice-endpointing.js desktop-client/renderer/renderer.js desktop-client/test/voice-endpointing.test.js
git commit -m "Add energy/loudness gate to desktop-client's barge-in hold timer (#340)"
```

---

## Task 5: windows-launcher — held-state hold/capture/classify/resume/discard/insert

**Files:**
- Modify: `windows-launcher/renderer/streaming-chunk-queue.js` (`peekPending()`)
- Modify: `windows-launcher/renderer/renderer.js`
- Test: `windows-launcher/test/streaming-chunk-queue.test.js`

**Interfaces:**
- Produces: `peekPending() -> string[]` on the queue returned by `createStreamingChunkQueue` — a copy of not-yet-dequeued chunk texts.
- Consumes: `nextBargeInState`, `dbfsFromSamples` (Task 3); `classifyBargeIn` via `POST /barge-in/classify` (Task 2); `handleTranscript(transcript, gamingModeActive)`, `refreshGamingStatus()`, `transcribeBlob(blob)`, `recordUntilSilence()`, `stopReplyAudio()`, `playAudioBlob`, `createStreamingChunkQueue`, `synthesizeSpeechChunk`, `detectReplyEmotion`, `setAvatarState`, `replyPlaybackToken` (all pre-existing in `renderer.js`).
- Produces: module-scope `heldReply` (`{sentences: string[], stackDepth: 0|1} | null`), `activeStreamingQueue`, `bargeInCaptureInProgress` — read by `listenLoop`'s gate.

Before writing code, re-read the current `playStreamingReply` (~line 1339-1413), `watchForBargeIn` (~line 1143-1206), and `listenLoop` (~line 2577-2628) in `windows-launcher/renderer/renderer.js` to confirm they still match the shapes referenced below.

- [ ] **Step 1: Write the failing test for `peekPending()`**

Add to `windows-launcher/test/streaming-chunk-queue.test.js`:

```js
test("peekPending() returns a snapshot of chunks not yet dequeued, without draining them", async () => {
  const q = makeQueue();
  q.queue.pushChunk("first");
  q.queue.pushChunk("second");
  q.queue.pushChunk("third");

  const runPromise = q.queue.run();
  await flushMicrotasks();
  // "first" was dequeued and handed to synthesize(); "second"/"third" remain.
  assert.deepEqual(q.queue.peekPending(), ["second", "third"]);

  q.queue.cancelPending();
  q.resolveSynth("first", "first-audio");
  await runPromise;
});

test("peekPending() on an empty, not-yet-started queue returns an empty array", () => {
  const q = makeQueue();
  assert.deepEqual(q.queue.peekPending(), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd windows-launcher && node --test test/streaming-chunk-queue.test.js`
Expected: FAIL with "q.queue.peekPending is not a function"

- [ ] **Step 3: Implement `peekPending()`**

In `windows-launcher/renderer/streaming-chunk-queue.js`, add next to `cancelPending`:

```js
  function peekPending() {
    return pending.slice();
  }
```

Update the returned object:

```js
  return { pushChunk, markDone, cancelPending, peekPending, run };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd windows-launcher && node --test test/streaming-chunk-queue.test.js`
Expected: PASS (all tests, existing + 2 new)

- [ ] **Step 5: Commit the queue change**

```bash
git add windows-launcher/renderer/streaming-chunk-queue.js windows-launcher/test/streaming-chunk-queue.test.js
git commit -m "Add peekPending() to windows-launcher's streaming chunk queue"
```

- [ ] **Step 6: Track the active queue and add held-state/capture/classify/dispatch functions**

In `windows-launcher/renderer/renderer.js`, add near the existing `let replyPlaybackToken = 0;` (~line 271):

```js
// Sub-project B: the streaming-chunk-queue currently backing playback, so a
// barge-in trigger can read its not-yet-played sentences. Set at the start
// of playStreamingReply, cleared once that call's queue has genuinely
// drained or been superseded -- see the `if (activeStreamingQueue === queue)`
// guard there, which stops a newer call's reference from being stomped by
// an older one's cleanup running late.
let activeStreamingQueue = null;

// { sentences: string[], stackDepth: 0|1 } while a reply is held mid-
// playback after a barge-in, else null. stackDepth 1 means this hold is
// "underneath" a currently-playing inserted new-question answer; a second
// interruption while stackDepth is 1 discards this hold instead of nesting
// (see handleBargeInTrigger).
let heldReply = null;

// True for the full span of a barge-in-triggered capture (recording the
// interruption through classifying and acting on it) -- listenLoop must not
// start its own recording during this window, since `processing` alone
// isn't reliably still true for that whole span (it flips false as soon as
// playStreamingReply's now-superseded queue finishes unwinding, which can
// happen well before the interruption has finished being captured).
let bargeInCaptureInProgress = false;
```

Add near `stopReplyAudio` (~line 1058), after it:

```js
// Sub-project B: re-speaks a held reply's remaining sentences from the cut
// point, reusing the same one-ahead synthesize/play queue playStreamingReply
// uses -- not a new playback primitive, just a second entry point into it,
// sourced from the held array instead of an NDJSON stream. Held state is
// text only; this re-synthesizes rather than replaying cached audio.
async function resumeHeldReply() {
  const sentences = heldReply ? heldReply.sentences : null;
  heldReply = null;
  if (!sentences || sentences.length === 0) {
    return;
  }

  stopReplyAudio();
  const playbackToken = replyPlaybackToken;
  const queue = createStreamingChunkQueue({
    synthesize: (text) => synthesizeSpeechChunk(0, [text], playbackToken),
    play: (audioBlob, text) =>
      playAudioBlob(audioBlob, playbackToken, detectReplyEmotion(text), undefined),
    isCurrent: () => replyPlaybackToken === playbackToken,
    onIdle: () => setAvatarState("idle"),
  });
  activeStreamingQueue = queue;
  const runPromise = queue.run();
  for (const sentence of sentences) {
    queue.pushChunk(sentence);
  }
  queue.markDone();
  await runPromise;
  if (activeStreamingQueue === queue) {
    activeStreamingQueue = null;
  }
}

async function classifyBargeInText(text) {
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/barge-in/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      return { category: "unclassified" };
    }
    const data = await response.json();
    return { category: data.category || "unclassified" };
  } catch (e) {
    console.warn("Barge-in classify request failed:", e.message);
    return { category: "unclassified" };
  }
}

// Acts on a classified interruption against the currently-held reply.
// `heldReply` must already be set (non-null) when this is called for the
// non-nested path -- see handleBargeInTrigger.
async function handleBargeInInterruption(category, transcript, gamingModeActive) {
  if (category === "correction") {
    heldReply = null;
    if (transcript) {
      await handleTranscript(transcript, gamingModeActive);
    }
    return;
  }

  if (category === "new_question") {
    heldReply.stackDepth = 1;
    if (transcript) {
      // handleTranscript -> requestScreenAwareReply -> playStreamingReply
      // already awaits full playback of the inserted answer before
      // returning, so resuming right after is safe -- no separate "wait for
      // playback to finish" step needed.
      await handleTranscript(transcript, gamingModeActive);
    }
    // A nested interruption during the line above discards heldReply itself
    // (see handleBargeInTrigger's wasNested branch) -- only resume if it's
    // still the same hold.
    if (heldReply) {
      await resumeHeldReply();
    }
    return;
  }

  // backchannel or unclassified: resume from the cut point, no new turn.
  await resumeHeldReply();
}

// Fired from watchForBargeIn once a trigger holds for BARGE_IN_HOLD_MS.
// Captures the current reply's not-yet-played sentences, records the
// interruption immediately (not waiting for listenLoop's next cycle),
// transcribes and classifies it, then dispatches to resume/discard/insert.
async function handleBargeInTrigger() {
  const wasNested = Boolean(heldReply && heldReply.stackDepth >= 1);
  const heldSentences = activeStreamingQueue ? activeStreamingQueue.peekPending() : [];
  stopReplyAudio();

  if (wasNested) {
    // A second interruption arrived while an inserted new-question answer
    // was playing -- per the depth-1 cap, the outer held reply is discarded
    // outright (not stacked); this interruption becomes a fresh top-level
    // turn, no classification needed since there's nothing left to
    // resume/discard against.
    heldReply = null;
    bargeInCaptureInProgress = true;
    try {
      const chunk = await recordUntilSilence();
      const result = await transcribeBlob(chunk);
      if (result.transcript) {
        const gamingModeActive = await refreshGamingStatus();
        await handleTranscript(result.transcript, gamingModeActive);
      }
    } catch (e) {
      console.warn("Barge-in interruption capture failed:", e.message);
    } finally {
      bargeInCaptureInProgress = false;
    }
    return;
  }

  if (heldSentences.length === 0) {
    // Nothing left to hold -- equivalent to today's stop-and-discard; the
    // normal listen loop picks up whatever comes next.
    return;
  }

  heldReply = { sentences: heldSentences, stackDepth: 0 };
  bargeInCaptureInProgress = true;
  try {
    const chunk = await recordUntilSilence();
    const result = await transcribeBlob(chunk);
    const { category } = await classifyBargeInText(result.transcript || "");
    const gamingModeActive = await refreshGamingStatus();
    await handleBargeInInterruption(category, result.transcript, gamingModeActive);
  } catch (e) {
    console.warn("Barge-in interruption capture failed:", e.message);
    heldReply = null;
  } finally {
    bargeInCaptureInProgress = false;
  }
}
```

- [ ] **Step 7: Set/clear `activeStreamingQueue` in `playStreamingReply`**

In `playStreamingReply`, change:

```js
  const queue = createStreamingChunkQueue({
    synthesize: (text) => synthesizeSpeechChunk(0, [text], playbackToken),
    play: (audioBlob, text) =>
      playAudioBlob(audioBlob, playbackToken, detectReplyEmotion(text), preferredExpression),
    isCurrent: () => replyPlaybackToken === playbackToken,
    onIdle: () => setAvatarState("idle"),
  });
  const runPromise = queue.run();
```

to:

```js
  const queue = createStreamingChunkQueue({
    synthesize: (text) => synthesizeSpeechChunk(0, [text], playbackToken),
    play: (audioBlob, text) =>
      playAudioBlob(audioBlob, playbackToken, detectReplyEmotion(text), preferredExpression),
    isCurrent: () => replyPlaybackToken === playbackToken,
    onIdle: () => setAvatarState("idle"),
  });
  activeStreamingQueue = queue;
  const runPromise = queue.run();
```

and change:

```js
  } finally {
    queue.markDone();
    await runPromise;
  }
```

to:

```js
  } finally {
    queue.markDone();
    await runPromise;
    if (activeStreamingQueue === queue) {
      activeStreamingQueue = null;
    }
  }
```

- [ ] **Step 8: Wire the trigger into `watchForBargeIn` and gate `listenLoop`**

In `watchForBargeIn`, replace:

```js
          speechStartedAt = state.speechStartedAt;
          if (state.triggered) {
            stopReplyAudio();
            break;
          }
```

with:

```js
          speechStartedAt = state.speechStartedAt;
          if (state.triggered) {
            handleBargeInTrigger().catch((e) =>
              console.warn("Barge-in interruption handling failed:", e.message),
            );
            break;
          }
```

In `listenLoop`, replace:

```js
    if (processing || currentReplyAudio) {
      await wait(LISTEN_PAUSE_MS);
      continue;
    }
```

with:

```js
    if (processing || currentReplyAudio || bargeInCaptureInProgress) {
      await wait(LISTEN_PAUSE_MS);
      continue;
    }
```

- [ ] **Step 9: Confirm `transcribeBlob`'s return shape**

Before moving on, re-read the existing `transcribeBlob` function in `windows-launcher/renderer/renderer.js` (used by `listenLoop`, ~line 2598: `const result = await transcribeBlob(chunk);`) to confirm it returns `{transcript}` (as used above) and matches how `handleBargeInTrigger` calls it. No code change expected here — this step is a verification checkpoint, since `handleBargeInTrigger` depends on this shape being exactly right.

- [ ] **Step 10: Manual verification**

Use the `run` skill to start `windows-launcher`.
1. Trigger a multi-sentence reply. While it's playing, say "mhm" or "okay" — confirm playback pauses, then resumes from roughly where it left off (not from the start).
2. Trigger a reply, interrupt with "wait, actually never mind" — confirm playback stops and does not resume; nothing further happens until you speak again.
3. Trigger a reply, interrupt with a real question ("what's the weather like") — confirm Mana answers the question, then resumes the original held reply afterward.
4. Repeat step 3, and interrupt again while the inserted answer is playing — confirm the original held reply does not come back; only the second interruption's turn happens.

- [ ] **Step 11: Commit**

```bash
git add windows-launcher/renderer/renderer.js
git commit -m "Add barge-in hold/classify/resume/discard/insert to windows-launcher (#339)"
```

---

## Task 6: desktop-client — held-state hold/capture/classify/resume/discard/insert

**Files:**
- Modify: `desktop-client/renderer/streaming-chunk-queue.js` (`peekPending()`)
- Modify: `desktop-client/renderer/renderer.js`
- Test: `desktop-client/test/streaming-chunk-queue.test.js`

**Interfaces:** mirrors Task 5, adapted to this app's token/`currentChunkSource`-based playback instead of `<audio>` elements, and its `handleVoiceTurn`/`replyInProgress`/`listenGeneration` shape.
- Produces: `transcribeBlob(blob) -> Promise<string>` and `handleTranscriptText(transcript) -> Promise<void>`, extracted from `handleVoiceTurn` — consumed by both `handleVoiceTurn` and the new barge-in dispatcher.

Before writing code, re-read the current `handleVoiceTurn`, `speakStreamingReply`, `playDecodedChunk`, `watchForBargeIn`, and `listenLoop` in `desktop-client/renderer/renderer.js` to confirm they still match the shapes referenced below.

- [ ] **Step 1: Add `peekPending()` to `desktop-client`'s queue (mirrors Task 5 Steps 1-5)**

Add the same two tests from Task 5 Step 1 to `desktop-client/test/streaming-chunk-queue.test.js` (same `makeQueue`/`flushMicrotasks` helpers already exist there, identical to `windows-launcher`'s).

Run: `cd desktop-client && node --test test/streaming-chunk-queue.test.js`
Expected: FAIL, then implement:

In `desktop-client/renderer/streaming-chunk-queue.js`, add next to `cancelPending` (inside the IIFE):

```js
  function peekPending() {
    return pending.slice();
  }
```

Update the returned object:

```js
  return { pushChunk, markDone, cancelPending, peekPending, run };
```

Run: `cd desktop-client && node --test test/streaming-chunk-queue.test.js`
Expected: PASS

```bash
git add desktop-client/renderer/streaming-chunk-queue.js desktop-client/test/streaming-chunk-queue.test.js
git commit -m "Add peekPending() to desktop-client's streaming chunk queue"
```

- [ ] **Step 2: Extract `transcribeBlob` and `handleTranscriptText` from `handleVoiceTurn`**

Replace the current `handleVoiceTurn` (~line 1063-1110):

```js
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
      if (j?.transcript) {
        appendMessage('user', j.transcript);
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
  async function transcribeBlob(blob) {
    const form = new FormData();
    form.append('file', blob, 'voice.webm');
    const resp = await fetch('http://127.0.0.1:5005/transcribe-only', { method: 'POST', body: form });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error('transcribe failed: ' + resp.status + ' ' + txt);
    }
    const j = await resp.json().catch(()=>null);
    return j?.transcript || '';
  }

  // Shared by handleVoiceTurn (push-to-talk/continuous-listening) and the
  // barge-in interruption dispatcher (Sub-project B) -- both end up with a
  // known transcript string and need the exact same reply-generation
  // handling.
  async function handleTranscriptText(transcript) {
    try{
      appendMessage('user', transcript);
      const result = await speakStreamingReply(
        {
          text: transcript,
          sessionId: ensureSessionId(),
          presetId: selectedPresetId || undefined,
        },
        (finalEvent) => {
          if (!finalEvent.error && finalEvent.reply) appendMessage('assistant', finalEvent.reply);
        },
      );
      if (result.error) throw new Error(result.error);
      statusEl.textContent = 'Idle';
    } catch (e){
      statusEl.textContent = 'Error';
      await window.electronAPI.showError(String(e));
      setSprite('idle');
    }
  }

  async function handleVoiceTurn(blob) {
    try {
      const transcript = await transcribeBlob(blob);
      if (transcript) {
        await handleTranscriptText(transcript);
      }
    } catch (e){
      statusEl.textContent = 'Error';
      await window.electronAPI.showError(String(e));
      setSprite('idle');
    }
  }
```

- [ ] **Step 3: Manually verify push-to-talk/continuous listening still work after the extraction**

Use the `run` skill to start `desktop-client`. Confirm both push-to-talk and continuous listening still transcribe and reply exactly as before. This is a behavior-preserving refactor with no automated coverage for renderer.js's live behavior, matching Sub-project A's same verification step for its own `handleVoiceTurn` extraction.

- [ ] **Step 4: Add held-state/capture/classify/dispatch state and functions**

Add near the existing `let bargeInMonitor = null;` (~line 658):

```js
  // Sub-project B: the streaming-chunk-queue currently backing playback, so
  // a barge-in trigger can read its not-yet-played sentences. Set at the
  // start of speakStreamingReply, cleared once that call's queue has
  // genuinely drained or been superseded.
  let activeStreamingQueue = null;

  // { sentences: string[], stackDepth: 0|1 } while a reply is held mid-
  // playback after a barge-in, else null.
  let heldReply = null;

  // True for the full span of a barge-in-triggered capture. listenLoop must
  // not start its own recording during this window, and recordUntilSilence's
  // Finding-4 replyInProgress guard must not abort *this* recording just
  // because the reply it interrupted hasn't finished unwinding yet.
  let bargeInCaptureInProgress = false;
```

Add near `stopStreamingReply` (after it):

```js
  // Sub-project B: re-speaks a held reply's remaining sentences from the cut
  // point, reusing the same synthesize/play queue speakStreamingReply uses.
  // Held state is text only; this re-synthesizes rather than replaying
  // cached audio.
  async function resumeHeldReply() {
    const sentences = heldReply ? heldReply.sentences : null;
    heldReply = null;
    if (!sentences || sentences.length === 0) {
      return;
    }

    stopStreamingReply();
    const playbackToken = desktopReplyPlaybackToken;
    const audioCtx = new AudioContext();
    const queue = createDesktopStreamingChunkQueue({
      synthesize: (text) => synthesizeAndDecodeChunk(text, audioCtx),
      play: (audioBuffer, text) => playDecodedChunk(audioCtx, audioBuffer, text),
      isCurrent: () => desktopReplyPlaybackToken === playbackToken,
      onIdle: () => setSprite('idle'),
    });
    activeStreamingQueue = queue;
    const runPromise = queue.run();
    for (const sentence of sentences) {
      queue.pushChunk(sentence);
    }
    queue.markDone();
    await runPromise;
    audioCtx.close().catch(() => {});
    if (activeStreamingQueue === queue) {
      activeStreamingQueue = null;
    }
  }

  async function classifyBargeInText(text) {
    try {
      const response = await fetch('http://127.0.0.1:5005/barge-in/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        return { category: 'unclassified' };
      }
      const data = await response.json();
      return { category: data.category || 'unclassified' };
    } catch (e) {
      console.warn('Barge-in classify request failed:', e.message);
      return { category: 'unclassified' };
    }
  }

  async function handleBargeInInterruption(category, transcript) {
    if (category === 'correction') {
      heldReply = null;
      if (transcript) {
        await handleTranscriptText(transcript);
      }
      return;
    }

    if (category === 'new_question') {
      heldReply.stackDepth = 1;
      if (transcript) {
        // speakStreamingReply already awaits full playback before
        // returning, so resuming right after is safe.
        await handleTranscriptText(transcript);
      }
      if (heldReply) {
        await resumeHeldReply();
      }
      return;
    }

    await resumeHeldReply();
  }

  // Fired from watchForBargeIn's onTrigger once a trigger holds for
  // BARGE_IN_HOLD_MS. Captures the current reply's not-yet-played
  // sentences, records the interruption immediately, transcribes and
  // classifies it, then dispatches to resume/discard/insert.
  async function handleDesktopBargeInTrigger() {
    const wasNested = Boolean(heldReply && heldReply.stackDepth >= 1);
    const heldSentences = activeStreamingQueue ? activeStreamingQueue.peekPending() : [];

    if (wasNested) {
      heldReply = null;
      bargeInCaptureInProgress = true;
      try {
        const blob = await recordUntilSilence();
        if (!blob) return;
        const transcript = await transcribeBlob(blob);
        if (transcript) {
          await handleTranscriptText(transcript);
        }
      } catch (e) {
        console.warn('Barge-in interruption capture failed:', e.message);
      } finally {
        bargeInCaptureInProgress = false;
      }
      return;
    }

    if (heldSentences.length === 0) {
      return;
    }

    heldReply = { sentences: heldSentences, stackDepth: 0 };
    bargeInCaptureInProgress = true;
    try {
      const blob = await recordUntilSilence();
      if (!blob) {
        await resumeHeldReply();
        return;
      }
      const transcript = await transcribeBlob(blob);
      const { category } = await classifyBargeInText(transcript);
      await handleBargeInInterruption(category, transcript);
    } catch (e) {
      console.warn('Barge-in interruption capture failed:', e.message);
      heldReply = null;
    } finally {
      bargeInCaptureInProgress = false;
    }
  }
```

- [ ] **Step 5: Bypass the Finding-4 guard for our own capture, in `recordUntilSilence`**

In `recordUntilSilence`'s `tick()`, replace:

```js
        if (replyInProgress) {
          noSpeechResult = true;
          if (localRecorder.state !== 'inactive') {
            localRecorder.stop();
          }
          return;
        }
```

with:

```js
        // Finding 4 exists to abort a listenLoop-triggered recording if an
        // *unrelated* reply started elsewhere mid-recording. It must not
        // abort our *own* barge-in capture just because the reply it
        // interrupted hasn't finished unwinding yet (replyInProgress can
        // stay true for a few ticks after stopStreamingReply() while
        // speakStreamingReply's superseded queue is still winding down).
        if (replyInProgress && !bargeInCaptureInProgress) {
          noSpeechResult = true;
          if (localRecorder.state !== 'inactive') {
            localRecorder.stop();
          }
          return;
        }
```

- [ ] **Step 6: Set/clear `activeStreamingQueue` in `speakStreamingReply`**

Change:

```js
      const queue = createDesktopStreamingChunkQueue({
        synthesize: (text) => synthesizeAndDecodeChunk(text, audioCtx),
        play: (audioBuffer, text) => playDecodedChunk(audioCtx, audioBuffer, text),
        isCurrent: () => desktopReplyPlaybackToken === playbackToken,
        onIdle: () => setSprite('idle'),
      });
      const runPromise = queue.run();
```

to:

```js
      const queue = createDesktopStreamingChunkQueue({
        synthesize: (text) => synthesizeAndDecodeChunk(text, audioCtx),
        play: (audioBuffer, text) => playDecodedChunk(audioCtx, audioBuffer, text),
        isCurrent: () => desktopReplyPlaybackToken === playbackToken,
        onIdle: () => setSprite('idle'),
      });
      activeStreamingQueue = queue;
      const runPromise = queue.run();
```

and change:

```js
      } finally {
        queue.markDone();
        await runPromise;
      }
```

to:

```js
      } finally {
        queue.markDone();
        await runPromise;
        if (activeStreamingQueue === queue) {
          activeStreamingQueue = null;
        }
      }
```

- [ ] **Step 7: Wire the trigger into `watchForBargeIn`'s two call sites and gate `listenLoop`**

In `playDecodedChunk`, replace:

```js
        watchForBargeIn(
          () => currentChunkSource !== null && desktopReplyPlaybackToken === playbackTokenAtStart,
          () => { if (currentChunkSource) currentChunkSource.stop(); stopStreamingReply(); },
        ).catch((e) => console.warn('Voice barge-in monitor failed:', e.message));
```

with:

```js
        watchForBargeIn(
          () => currentChunkSource !== null && desktopReplyPlaybackToken === playbackTokenAtStart,
          () => {
            if (currentChunkSource) currentChunkSource.stop();
            stopStreamingReply();
            handleDesktopBargeInTrigger().catch((e) =>
              console.warn('Barge-in interruption handling failed:', e.message),
            );
          },
        ).catch((e) => console.warn('Voice barge-in monitor failed:', e.message));
```

In the `speakReply` fallback's `watchForBargeIn` call, replace:

```js
            watchForBargeIn(
              () => currentChunkSource !== null && desktopReplyPlaybackToken === playbackTokenAtStart,
              () => { if (currentChunkSource) currentChunkSource.stop(); stopStreamingReply(); },
            ).catch((e) => console.warn('Voice barge-in monitor failed:', e.message));
```

with:

```js
            watchForBargeIn(
              () => currentChunkSource !== null && desktopReplyPlaybackToken === playbackTokenAtStart,
              () => {
                if (currentChunkSource) currentChunkSource.stop();
                stopStreamingReply();
                handleDesktopBargeInTrigger().catch((e) =>
                  console.warn('Barge-in interruption handling failed:', e.message),
                );
              },
            ).catch((e) => console.warn('Voice barge-in monitor failed:', e.message));
```

Note: `handleDesktopBargeInTrigger`'s `activeStreamingQueue.peekPending()` will be empty in the `speakReply` fallback case, since that path plays through its own `AudioContext`/source outside the streaming-chunk-queue (see its existing comment) — so a barge-in during the fallback path stays stop-and-discard, consistent with the Global Constraints' "non-streaming fallback keeps today's behavior."

In `listenLoop`, replace:

```js
      if (replyInProgress) {
        await wait(LISTEN_PAUSE_MS);
        continue;
      }
```

with:

```js
      if (replyInProgress || bargeInCaptureInProgress) {
        await wait(LISTEN_PAUSE_MS);
        continue;
      }
```

- [ ] **Step 8: Manual verification**

Same four scenarios as Task 5 Step 10, run against `desktop-client`.

- [ ] **Step 9: Commit**

```bash
git add desktop-client/renderer/renderer.js
git commit -m "Add barge-in hold/classify/resume/discard/insert to desktop-client (#339)"
```

---

## Self-Review Notes

- **Spec coverage:** Flow (stop → hold → capture → classify → resume/discard/insert) → Tasks 5/6. Energy/loudness gate → Tasks 3/4. Backend classifier → Task 1. Backend endpoint → Task 2. Held-state (text-only, `peekPending()`-sourced) → Tasks 5/6. Depth-1 nesting cap → Tasks 5/6's `wasNested` branch. Non-streaming fallback keeps stop-and-discard → confirmed by construction (Task 6 Step 7's note) and by Task 5/6 only wiring `activeStreamingQueue` into the streaming path, never `playReplyAudio`/the `speakReply` fallback. No generation-abort → confirmed by construction (no `AbortController` anywhere in this plan).
- **Placeholder scan:** Every step has complete, concrete code. Tasks 5/6's Step 9 (windows-launcher) and the various "before writing code, re-read the current file" notes are explicit, flagged verification checkpoints against a live-evolving file (matching Sub-project A's plan's own precedent), not silent placeholders.
- **Type consistency:** `classifyBargeIn(text) -> {category, reason}` (Task 1) is used identically by the `/barge-in/classify` route (Task 2) and by both apps' `classifyBargeInText` (Tasks 5/6), which normalize its `category` into the same four string values (`backchannel`/`correction`/`new_question`/`unclassified`) both dispatchers switch on. `nextBargeInState`'s new `isLoudEnough` param (Tasks 3/4) defaults to `true`, verified not to change any existing caller's behavior, and is wired identically in both apps' `watchForBargeIn`. `peekPending()` (Tasks 5/6) returns the same `string[]` shape in both apps' queue modules. `heldReply`'s shape (`{sentences, stackDepth}`) is identical across both apps' `handleBargeInInterruption`/`handleBargeInTrigger` implementations.
