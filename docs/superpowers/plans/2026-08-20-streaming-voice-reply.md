# Streaming Voice Reply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut Mana's perceived reply latency by starting text-to-speech on the first sentence of a reply while the LLM is still generating the rest, instead of waiting for the whole reply to finish before any audio starts — closing issue #331, in both `windows-launcher` and `desktop-client`.

**Architecture:** The LLM-side plumbing already exists and is merged but unused: `streamLocalAssistantReply()` (`node-bot/ai/llama-server-runtime.js:647`) streams llama-server's SSE output through a think-filter and sentence chunker, firing an `onSentence(sentence)` callback per completed sentence. This plan wires that callback into `buildAssistantReply`'s plain local-completion path only (the one leaf that can literally stream token-by-token), exposes it over a new NDJSON route (`POST /reply/stream`), and teaches both renderer apps to consume sentences as they arrive and queue them into TTS/playback incrementally — reusing `windows-launcher`'s existing chunk-queue/pipelining/cancellation machinery, and porting that same shape into `desktop-client`, which has none of it today.

Streaming only originates from the first, plain local-completion attempt. Tool-calling, best-of-N, and any regeneration triggered by rut-detection or reply-verification don't stream (those paths don't produce sentence-by-sentence text, or can throw the whole reply away) — instead, the final event carries a `changed` flag. If what was already streamed and spoken doesn't match the model's true final reply, the client cancels whatever's queued/playing (via the existing `playbackToken` mechanism in `windows-launcher`, ported to `desktop-client`) and falls back to today's synthesize-the-whole-thing-at-once behavior. This makes streaming purely an optimistic latency win on the common path, with the existing non-streaming behavior as the correctness backstop on every other path.

**Tech Stack:** Node.js/Express (`node-bot`), vanilla JS Electron renderers (`windows-launcher`, `desktop-client`), NDJSON-over-chunked-HTTP-response (the codebase's existing streaming convention, e.g. `node-bot/capabilities/background-memory-capability.js:492-514`) — not SSE, no new dependency.

**Spec:** GitHub issue [#331](https://github.com/Yuuzulight/Mana/issues/331) "Stream text and voice together instead of waiting for the full reply", plus the 2026-08-20 comment on that issue documenting that S1-mini's server already supports `streaming: true` for within-sentence audio chunking (explicitly **out of scope** for this plan — see below).

## Global Constraints

- Do not change `POST /reply`'s existing request/response contract — it's used by other callers (mobile app, ACP agent) this plan doesn't touch. Add a new `POST /reply/stream` route instead.
- `buildAssistantReply`'s return type stays a plain string for every call site (an existing constraint already documented at `node-bot/server.js:3979-3983`) — the streaming hook is an additional optional trailing parameter plus a new `replyMeta.streamedMatchesFinal` out-value, not a return-type change.
- Streaming fires for the first plain local-completion attempt only. Regeneration (rut-detection nudge, verify/retry, tool-calling, best-of-N) never streams — this is a deliberate scope cut to avoid interleaved/overlapping sentence streams from multiple generation attempts; correctness is guaranteed by the `changed` flag and client-side cancel-and-restart, not by trying to stream every path.
- **Out of scope:** within-sentence audio streaming (S1-mini's `ServeTTSRequest.streaming: true`, already supported server-side per the #331 comment). That's a separate, smaller, independent follow-up — this plan only pipelines whole-sentence TTS requests, unchanged from how `windows-launcher` already calls `/synthesize` today (one blocking request per chunk, full WAV blob back).
- No new dependency: NDJSON parsing client-side is a newline-split + `JSON.parse` loop, matching `node-bot/utils/sse-sentence-stream.js`'s existing `readSseDeltas` shape.

---

## File Structure

- **Create** `node-bot/utils/reply-stream-diff.js` — pure function comparing streamed sentences against the final reply text. Kept separate from `server.js` so it's testable without spinning up the whole reply pipeline.
- **Create** `node-bot/test/reply-stream-diff.test.js`
- **Modify** `node-bot/server.js` — `buildAssistantReply` gains a trailing optional `onSentence` parameter, wired only into the first plain local-completion call.
- **Modify** `node-bot/server-routes.js` — new `POST /reply/stream` NDJSON route, mirroring `/reply`'s validation/branching.
- **Create** `node-bot/test/reply-stream-route.test.js`
- **Modify** `windows-launcher/renderer/renderer.js` — new NDJSON reader, chunk queue refactored to accept sentences pushed in over time instead of only a pre-known array, new streaming entry point wired at the two existing call sites.
- **Modify** `desktop-client/renderer/renderer.js` — port the same queue/pipeline/cancellation shape from `windows-launcher` (this app currently has none of it), wired at its two existing call sites.

---

## Task 1: `reply-stream-diff` helper

**Files:**
- Create: `node-bot/utils/reply-stream-diff.js`
- Test: `node-bot/test/reply-stream-diff.test.js`

**Interfaces:**
- Produces: `streamedMatchesFinal(streamedSentences: string[], finalReply: string): boolean` — used by Task 2.

- [ ] **Step 1: Write the failing test**

```js
// node-bot/test/reply-stream-diff.test.js
const assert = require("node:assert");
const { test } = require("node:test");
const { streamedMatchesFinal } = require("../utils/reply-stream-diff");

test("matches when final reply is exactly the joined streamed sentences", () => {
  assert.strictEqual(
    streamedMatchesFinal(["Hello there.", "How can I help?"], "Hello there. How can I help?"),
    true,
  );
});

test("does not match when final reply diverges (regen/rewrite changed it)", () => {
  assert.strictEqual(
    streamedMatchesFinal(["Hello there."], "Hi! What's up?"),
    false,
  );
});

test("does not match when nothing streamed (tool-aware/best-of-N path)", () => {
  assert.strictEqual(streamedMatchesFinal([], "Some reply from a tool call."), false);
});

test("tolerates surrounding whitespace differences", () => {
  assert.strictEqual(
    streamedMatchesFinal(["One.", "Two."], "  One. Two.  \n"),
    true,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test node-bot/test/reply-stream-diff.test.js`
Expected: FAIL with `Cannot find module '../utils/reply-stream-diff'`

- [ ] **Step 3: Write minimal implementation**

```js
// node-bot/utils/reply-stream-diff.js
// Issue #331: buildAssistantReply's post-processing (rut-detection regen,
// verify/retry, phrasing-variation rewrite) can replace the reply text
// wholesale after streaming has already started speaking sentences from
// the first draft. This is the single source of truth for "does what was
// already streamed and spoken still match the true final reply" -- kept as
// a pure function so the cancel-and-restart decision is testable without a
// live model or TTS service.
function streamedMatchesFinal(streamedSentences, finalReply) {
  if (!Array.isArray(streamedSentences) || streamedSentences.length === 0) {
    return false;
  }
  const streamedJoined = streamedSentences.join(" ").trim();
  const final = String(finalReply ?? "").trim();
  return streamedJoined === final;
}

module.exports = { streamedMatchesFinal };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test node-bot/test/reply-stream-diff.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add node-bot/utils/reply-stream-diff.js node-bot/test/reply-stream-diff.test.js
git commit -m "Add reply-stream-diff helper for issue #331 streaming"
```

---

## Task 2: Wire `onSentence` into `buildAssistantReply`'s first-pass local completion

**Files:**
- Modify: `node-bot/server.js:3385` (function signature), `node-bot/server.js:4010-4018` (the plain local-completion call inside `replyMaybeWithTools`), `node-bot/server.js:4083` (the first call to `replyMaybeWithBestOfN`), and just before the final `return reply;` at the end of `buildAssistantReply`.
- Test: `node-bot/test/server-build-assistant-reply-streaming.test.js` (new)

**Interfaces:**
- Consumes: `streamedMatchesFinal` from Task 1 (`node-bot/utils/reply-stream-diff.js`).
- Consumes: `llamaServerRuntime.streamLocalAssistantReply(prompt, {maxTokens, profile, overrideSystemPrompt, extraMessages, onSentence, maxSentenceChars})` — already exists at `node-bot/ai/llama-server-runtime.js:647`, returns the full reply text (a string) and calls `onSentence(sentence)` per completed sentence, in order, before resolving.
- Produces: `buildAssistantReply(transcript, screenText, marketText, modelProfile, sessionId, assistantMode, presetId, replyMeta, onSentence = null)` — one new trailing optional parameter. When provided, `onSentence(sentence: string)` is called zero or more times during the first plain local-completion attempt only. After `buildAssistantReply` resolves, `replyMeta.streamedMatchesFinal` (boolean) tells the caller whether everything already streamed and spoken still matches the true final reply.

- [ ] **Step 1: Write the failing test**

This test exercises `buildAssistantReply` with a fake `llamaServerRuntime` (via the existing `deps` injection pattern already used elsewhere in `server.js` — check the top of `server.js`'s exported factory function for how `deps.runLocalAssistantReply` etc. are already overridable in tests, and follow that same pattern for `deps.llamaServerRuntime`).

```js
// node-bot/test/server-build-assistant-reply-streaming.test.js
const assert = require("node:assert");
const { test } = require("node:test");
const { createServer } = require("../server"); // adjust to the actual exported factory name used by existing server.js tests -- grep node-bot/test/*.test.js for `require("../server")` to confirm the export shape before writing this call

test("onSentence fires per streamed sentence and replyMeta.streamedMatchesFinal is true when nothing rewrites the reply", async () => {
  const seen = [];
  const fakeLlamaServerRuntime = {
    isEnabled: () => true,
    streamLocalAssistantReply: async (prompt, opts) => {
      await opts.onSentence("Hello there.");
      await opts.onSentence("How can I help?");
      return "Hello there. How can I help?";
    },
    runToolAwareReply: async () => ({ content: "", toolCalls: [], rounds: 0 }),
    runBestOfNReply: async () => ({ content: "" }),
  };

  const app = createServer({ llamaServerRuntime: fakeLlamaServerRuntime /* plus whatever other deps the existing test suite already stubs for a minimal buildAssistantReply call -- copy the stub set from an existing node-bot/test/server*.test.js that already calls buildAssistantReply successfully */ });

  const replyMeta = {};
  const reply = await app.deps.buildAssistantReply(
    "hi",
    "",
    "",
    "default",
    null,
    null,
    null,
    replyMeta,
    (sentence) => seen.push(sentence),
  );

  assert.strictEqual(reply, "Hello there. How can I help?");
  assert.deepStrictEqual(seen, ["Hello there.", "How can I help?"]);
  assert.strictEqual(replyMeta.streamedMatchesFinal, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test node-bot/test/server-build-assistant-reply-streaming.test.js`
Expected: FAIL — `buildAssistantReply` does not yet accept a 9th `onSentence` argument, `replyMeta.streamedMatchesFinal` is `undefined`, `reply` mismatches because today's code always calls the non-streaming path.

Before writing Step 3, actually read `node-bot/test/server.test.js` (or whichever existing test file already successfully constructs a minimal `buildAssistantReply`-capable server via `deps`) to copy its exact stub shape — the snippet above intentionally leaves that part loose because the precise `deps` stub set (mock `llamaServerRuntime`, mock model-profile helpers, etc.) needs to match whatever this codebase's existing tests already use, not be reinvented here.

- [ ] **Step 3: Modify `buildAssistantReply`'s signature**

In `node-bot/server.js`, change:

```js
  async function buildAssistantReply(
```

(around line 3385) to add the new trailing parameter — read the existing full parameter list at that line first and append `onSentence = null` after `replyMeta` (whatever `replyMeta`'s existing default is, keep it, just add the new one after it).

- [ ] **Step 4: Add first-pass streaming gate and sentence tracking**

Near the top of `buildAssistantReply`'s body (before `replyMaybeWithTools` is defined, since both need to be visible to it via closure), add:

```js
    // Issue #331: onSentence streams only the very first plain local-
    // completion attempt. Regeneration (rut-detection nudge, verify/retry)
    // reuses replyMaybeWithBestOfN/replyMaybeWithTools too, but must not
    // stream again -- multiple overlapping sentence streams from separate
    // generation attempts would be nonsensical to a client. This flag makes
    // "first call only" explicit rather than relying on call order.
    let firstPassStreamed = false;
    const streamedSentences = [];
    const wrappedOnSentence = onSentence
      ? async (sentence) => {
          streamedSentences.push(sentence);
          await onSentence(sentence);
        }
      : null;
```

- [ ] **Step 5: Change the plain local-completion call site to stream when available**

In `node-bot/server.js`, inside `replyMaybeWithTools`, replace (around line 4010-4017):

```js
      return runLocalAssistantReply(
        promptText,
        LLAMA_MAX_TOKENS,
        normalizedModelProfile,
        selectedSystemPrompt,
        memoryExtraMessages,
      );
    }
```

with:

```js
      if (wrappedOnSentence && !firstPassStreamed && isLlamaServerAvailable()) {
        firstPassStreamed = true;
        try {
          return await llamaServerRuntime.streamLocalAssistantReply(promptText, {
            maxTokens: LLAMA_MAX_TOKENS,
            profile: normalizedModelProfile,
            overrideSystemPrompt: selectedSystemPrompt,
            extraMessages: memoryExtraMessages,
            onSentence: wrappedOnSentence,
          });
        } catch (e) {
          console.warn(
            "Streaming local reply failed, falling back to non-streaming:",
            e && e.message ? e.message : e,
          );
        }
      }
      return runLocalAssistantReply(
        promptText,
        LLAMA_MAX_TOKENS,
        normalizedModelProfile,
        selectedSystemPrompt,
        memoryExtraMessages,
      );
    }
```

Note `firstPassStreamed` is set to `true` *before* the attempt, not just on success — a failed streaming attempt must not retry streaming on a later regeneration call either, since sentences may have already been partially emitted (and possibly already spoken client-side) before the failure.

- [ ] **Step 6: Compute `replyMeta.streamedMatchesFinal` before returning**

Find the end of `buildAssistantReply`, right before its final `return reply;` (after the phrasing-variation rewrite pass, i.e. after the code block starting at `node-bot/server.js:4199` "Anti-formulaic-phrasing rewrite pass"). Add, immediately before that final `return reply;`:

```js
    if (replyMeta) {
      replyMeta.streamedMatchesFinal = streamedMatchesFinal(streamedSentences, reply);
    }
```

And add the import at the top of `node-bot/server.js` alongside its other `require("./utils/...")` calls:

```js
const { streamedMatchesFinal } = require("./utils/reply-stream-diff");
```

- [ ] **Step 7: Run test to verify it passes**

Run: `node --test node-bot/test/server-build-assistant-reply-streaming.test.js`
Expected: PASS

- [ ] **Step 8: Run the full existing server test suite to check for regressions**

Run: `node --test node-bot/test/*.test.js`
Expected: PASS (no existing test's `buildAssistantReply` call should break — the new parameter is optional and defaults to `null`, and when `onSentence` is `null`, `wrappedOnSentence` is `null`, so the new `if` branch at Step 5 is skipped entirely and behavior is byte-for-byte identical to today).

- [ ] **Step 9: Commit**

```bash
git add node-bot/server.js node-bot/test/server-build-assistant-reply-streaming.test.js
git commit -m "Wire onSentence streaming into buildAssistantReply's first-pass local completion (#331)"
```

---

## Task 3: `POST /reply/stream` NDJSON route

**Files:**
- Modify: `node-bot/server-routes.js` (add new route near the existing `/reply` route at line 169-282)
- Test: `node-bot/test/reply-stream-route.test.js` (new)

**Interfaces:**
- Consumes: `buildAssistantReply(...)` with the new 9th `onSentence` parameter from Task 2.
- Produces: `POST /reply/stream` — same request body shape as `POST /reply` (`text`, `image`, `screenText`, `sessionId`, `assistantMode`, `presetId`, `modelProfile`, `includeContext`, `ffxivWorld`). Response: `Content-Type: application/x-ndjson`, one JSON object per line:
  - `{"type":"sentence","text":"..."}` — zero or more, in order, as the first-pass local completion streams.
  - `{"type":"final","reply":"...","ttsConfigured":true,"changed":false,"expression":"..."?}` — exactly one, always last. `changed:true` means the client must discard/cancel anything already queued from `sentence` events and re-synthesize `reply` from scratch (covers: nothing streamed at all, e.g. tool-calling/best-of-N/vision/restart paths, as well as regeneration that changed the text).
  - `{"type":"final","error":"..."}` — on failure, instead of the success shape above.

- [ ] **Step 1: Write the failing test**

```js
// node-bot/test/reply-stream-route.test.js
const assert = require("node:assert");
const { test } = require("node:test");
const http = require("node:http");
// Adjust this import to however node-bot/test/*.test.js already spins up
// an app instance with injected deps for route tests -- grep for an
// existing test that hits POST /reply and copy its app-construction and
// http-request helper exactly, then point it at /reply/stream instead.

async function collectNdjson(res) {
  let buffer = "";
  const lines = [];
  for await (const chunk of res) {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim()) lines.push(JSON.parse(line));
    }
  }
  return lines;
}

test("POST /reply/stream emits sentence events then one final event", async () => {
  // Construct the app with a buildAssistantReply stub that calls the
  // 9th onSentence argument twice before resolving, matching Task 2's
  // fake-llama-server-runtime test shape.
  const events = await collectNdjson(/* response stream from POST /reply/stream {text:"hi"} */);
  assert.deepStrictEqual(events[0], { type: "sentence", text: "Hello there." });
  assert.deepStrictEqual(events[1], { type: "sentence", text: "How can I help?" });
  assert.strictEqual(events[2].type, "final");
  assert.strictEqual(events[2].reply, "Hello there. How can I help?");
  assert.strictEqual(events[2].changed, false);
});

test("POST /reply/stream: tool-aware path emits only a final event with changed:true", async () => {
  // Stub buildAssistantReply so it never calls onSentence (simulating the
  // tool-aware/best-of-N path), and returns a fixed reply string.
  const events = await collectNdjson(/* response stream */);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].type, "final");
  assert.strictEqual(events[0].changed, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test node-bot/test/reply-stream-route.test.js`
Expected: FAIL — `POST /reply/stream` does not exist (404).

- [ ] **Step 3: Add the route**

In `node-bot/server-routes.js`, immediately after the closing `});` of the existing `/reply` route (after line 282), add:

```js
  app.post("/reply/stream", async (req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const writeEvent = (event) => res.write(JSON.stringify(event) + "\n");

    try {
      const image =
        typeof req.body?.image === "string" && req.body.image.trim()
          ? req.body.image.trim()
          : null;
      const transcript = image
        ? optionalString(req.body?.text, "text", "")
        : requireString(req.body?.text, "text");

      if (isRestartCommand(transcript)) {
        if (!hasRestartController(restartController)) {
          writeEvent({ type: "final", error: "restart controller is not configured" });
          return res.end();
        }
        const payload = restartController.buildAcceptedPayload();
        scheduleRestartAfterFinish(res, restartController);
        writeEvent({
          type: "final",
          reply: payload.message,
          restart: payload,
          ttsConfigured: false,
          changed: true,
        });
        return res.end();
      }

      if (image) {
        const sessionId = optionalString(req.body?.sessionId, "sessionId", null);
        if (typeof getVisionStatus === "function") {
          const vision = getVisionStatus();
          if (!vision || !vision.available) {
            writeEvent({
              type: "final",
              error: "no local vision model available",
              detail: vision ? vision.reason : undefined,
            });
            return res.end();
          }
        }
        const reply = await runVisionReply(transcript, [image]);
        if (sessionId && typeof recordChatTurn === "function") {
          recordChatTurn(sessionId, transcript || "(shared an image)", reply);
        }
        writeEvent({
          type: "final",
          reply,
          ttsConfigured: TTS_PROVIDER !== "none",
          changed: true,
        });
        return res.end();
      }

      const screenText = clampText(
        optionalString(req.body?.screenText, "screenText", ""),
        SCREEN_CONTEXT_MAX_CHARS,
      );
      const hasModelProfile = Object.prototype.hasOwnProperty.call(
        req.body || {},
        "modelProfile",
      );
      const modelProfile = hasModelProfile
        ? normalizeLlamaModelProfile(req.body?.modelProfile)
        : normalizeLlamaModelProfile(
            typeof getActiveModelProfile === "function"
              ? getActiveModelProfile()
              : "default",
          );
      const includeContext = req.body?.includeContext !== false;
      const world = optionalString(
        req.body?.ffxivWorld,
        "ffxivWorld",
        UNIVERSALIS_DEFAULT_WORLD,
      );
      const marketText = includeContext
        ? await contributePluginPromptContext(capabilities, transcript, {
            marketDataClient,
            jobApplicationsStore,
            pluginSettingsStore,
            world,
            screenText,
          })
        : "";
      const sessionId = optionalString(req.body?.sessionId, "sessionId", null);
      const assistantMode = optionalString(req.body?.assistantMode, "assistantMode", null);
      const presetId = optionalString(req.body?.presetId, "presetId", null);
      const replyMeta = {};

      const reply = await buildAssistantReply(
        transcript,
        screenText,
        marketText,
        modelProfile,
        sessionId,
        assistantMode,
        presetId,
        replyMeta,
        (sentence) => writeEvent({ type: "sentence", text: sentence }),
      );

      writeEvent({
        type: "final",
        reply,
        ttsConfigured: TTS_PROVIDER !== "none",
        changed: !replyMeta.streamedMatchesFinal,
        ...(replyMeta.expression ? { expression: replyMeta.expression } : {}),
      });
      return res.end();
    } catch (e) {
      if (e instanceof ValidationError) {
        writeEvent({ type: "final", error: e.message });
        return res.end();
      }
      console.error(e);
      writeEvent({ type: "final", error: String(e) });
      return res.end();
    }
  });
```

Headers are set as the very first statement, before any validation can throw, so every exit path (including the `catch` block) can safely `res.write` NDJSON instead of needing a plain `res.status(...).json(...)` fallback.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test node-bot/test/reply-stream-route.test.js`
Expected: PASS

- [ ] **Step 5: Run the full existing route test suite to check for regressions**

Run: `node --test node-bot/test/*.test.js`

- [ ] **Step 6: Commit**

```bash
git add node-bot/server-routes.js node-bot/test/reply-stream-route.test.js
git commit -m "Add POST /reply/stream NDJSON route (#331)"
```

---

## Task 4: `windows-launcher` — NDJSON reader + incremental chunk queue

**Files:**
- Modify: `windows-launcher/renderer/renderer.js`

**Interfaces:**
- Consumes: `POST /reply/stream` from Task 3.
- Consumes (existing, unchanged): `synthesizeSpeechChunk(index, chunks, playbackToken)` (`windows-launcher/renderer/renderer.js:1102-1132`), `playAudioBlob(audioBlob, playbackToken, avatarState, preferredExpression)` (`:1207-1264`), `stopReplyAudio()` (`:1057-1068`), `splitReplyForSpeech` (`:1070-1100`), module-level `currentReplyAudio`/`currentReplyUrl`/`replyPlaybackToken` (`:268-270`).
- Produces: `playStreamingReply(transcript, requestBody, avatarState, preferredExpression)` — new function replacing the current `fetch("/reply") → res.json() → playReplyAudio(json.reply)` flow at the two call sites (`:2205`, `:2441`).

Before writing code, read the actual current contents of `windows-launcher/renderer/renderer.js` at lines 260-280 (state), 1050-1140 (`stopReplyAudio`, `splitReplyForSpeech`, `synthesizeSpeechChunk`), 1200-1310 (`playAudioBlob`, `playReplyAudio`), and 2190-2220 / 2420-2450 (the two call sites) — this plan's code below is written against those ranges as reported by an earlier research pass in this session, but line numbers drift as the file changes; re-read before editing rather than trusting the numbers blindly.

- [ ] **Step 1: Add an NDJSON line reader**

Add near the top of `windows-launcher/renderer/renderer.js`, alongside other pure helper functions (not inside any existing function):

```js
// Issue #331: POST /reply/stream sends newline-delimited JSON objects over
// a chunked response -- one "sentence" event per completed sentence, then
// exactly one "final" event. This mirrors node-bot/utils/sse-sentence-
// stream.js's readSseDeltas shape (buffer partial lines across network
// chunks) but for plain NDJSON instead of "data:"-prefixed SSE frames.
async function* readNdjsonEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch (e) {
        // A malformed line costs one event, not the whole stream.
      }
    }
  }
}
```

- [ ] **Step 2: Refactor the chunk queue to accept sentences pushed in over time**

Read the current `playReplyAudio(text, preferredExpression)` (`:1271-1302`) in full first — it currently does `const chunks = splitReplyForSpeech(text); for (const [index] of chunks.entries()) { ... }`, with one-ahead pipelining via a single `nextAudioBlobPromise` variable, gated by comparing a captured `playbackToken` against the live `replyPlaybackToken`.

Add a new function that generalizes this loop to consume from a queue that can still be growing when playback starts, instead of requiring `chunks` to be fully known upfront:

```js
// Issue #331: same one-ahead pipelining and playbackToken cancellation
// playReplyAudio already does over a fixed chunks[] array, generalized to
// a queue that new sentences can still be pushed into while it's running
// -- needed because streamed sentences arrive over time, not all at once.
// pushChunk(text) may be called after playback has started; markDone()
// signals no more chunks are coming, so the loop can exit after the last
// one plays instead of waiting forever.
function createStreamingChunkQueue(playbackToken, avatarState, preferredExpression) {
  const pending = [];
  let waiter = null; // resolve function for a consumer awaiting the next chunk
  let done = false;

  function pushChunk(text) {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve({ text, finished: false });
    } else {
      pending.push(text);
    }
  }

  function markDone() {
    done = true;
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve({ text: null, finished: true });
    }
  }

  async function nextChunk() {
    if (pending.length) return { text: pending.shift(), finished: false };
    if (done) return { text: null, finished: true };
    return new Promise((resolve) => {
      waiter = resolve;
    });
  }

  async function run() {
    let index = 0;
    let currentBlobPromise = null;
    for (;;) {
      if (replyPlaybackToken !== playbackToken) return; // superseded, stop silently
      const { text, finished } = currentBlobPromise
        ? { text: undefined, finished: false } // placeholder, overwritten below
        : await nextChunk();
      if (!currentBlobPromise) {
        if (finished) return;
        currentBlobPromise = synthesizeSpeechChunk(index, [text], playbackToken);
      }
      const audioBlob = await currentBlobPromise;
      if (replyPlaybackToken !== playbackToken) return;
      const { text: nextText, finished: nextFinished } = await nextChunk();
      currentBlobPromise = nextFinished ? null : synthesizeSpeechChunk(index + 1, [nextText], playbackToken);
      if (audioBlob) {
        await playAudioBlob(audioBlob, playbackToken, avatarState, preferredExpression);
      }
      if (nextFinished && !currentBlobPromise) return;
      index += 1;
    }
  }

  return { pushChunk, markDone, run };
}
```

(This reimplements the one-ahead lookahead windows-launcher's existing `playReplyAudio` already does, but over a live queue instead of a fixed array — the loop shape intentionally mirrors it so the two stay easy to compare.)

- [ ] **Step 3: Add `playStreamingReply`**

```js
// Issue #331: replaces the fetch("/reply") -> res.json() -> playReplyAudio
// flow at this app's two reply call sites. Sentences arrive incrementally
// from POST /reply/stream and are queued for TTS/playback as they arrive;
// on the final event, if what was already streamed doesn't match the true
// final reply (changed:true -- covers both "nothing streamed" and "a
// regeneration pass rewrote it"), cancel the queue and fall back to
// today's synthesize-the-whole-thing-at-once path unchanged.
async function playStreamingReply(requestBody, avatarState, preferredExpression) {
  const playbackToken = ++replyPlaybackToken;
  const queue = createStreamingChunkQueue(playbackToken, avatarState, preferredExpression);
  const runPromise = queue.run();

  const response = await fetch(`${BACKEND_BASE_URL}/reply/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  let finalEvent = null;
  for await (const event of readNdjsonEvents(response)) {
    if (replyPlaybackToken !== playbackToken) break; // superseded mid-stream
    if (event.type === "sentence") {
      queue.pushChunk(event.text);
    } else if (event.type === "final") {
      finalEvent = event;
    }
  }
  queue.markDone();
  await runPromise;

  if (replyPlaybackToken !== playbackToken) {
    return finalEvent || { reply: "", ttsConfigured: false };
  }

  if (finalEvent && finalEvent.changed) {
    stopReplyAudio();
    if (finalEvent.reply) {
      await playReplyAudio(finalEvent.reply, finalEvent.expression);
    }
  }

  return finalEvent || { reply: "", ttsConfigured: false };
}
```

- [ ] **Step 4: Wire the two call sites**

Read the current code around `windows-launcher/renderer/renderer.js:2205` (voice hotkey reply) and `:2441` (main reply flow) — both currently do something like:

```js
const response = await fetch(`${BACKEND_BASE_URL}/reply`, { method: "POST", headers: {...}, body: JSON.stringify({...}) });
const json = await response.json();
await playReplyAudio(json.reply, json.expression);
```

Replace each with a call to the new function, preserving the exact same request-body construction and the surrounding `try/finally` (`processing = false`) at each site:

```js
const result = await playStreamingReply(requestBodyObjectAlreadyBuiltAtThisCallSite, avatarState, undefined);
// wherever json.reply / json.expression / json.ttsConfigured were used after the old
// fetch+playReplyAudio call, use result.reply / result.expression / result.ttsConfigured instead.
```

Do not change anything else at these call sites — chat-log text rendering, session-memory recording, and any other post-reply UI update should keep reading from `result.reply` (the true final text) exactly as they previously read from `json.reply`.

- [ ] **Step 5: Manual test**

Use the `run` skill to start `windows-launcher`, send a multi-sentence chat message, and confirm: audio starts noticeably before the full reply would have finished generating, sentences play back-to-back with no gap or overlap, and the chat log shows the complete final reply text (not a truncated/streamed partial). Then test a case that forces `changed:true` (e.g. temporarily set `MANA_RUT_DETECTION_ENABLED=1` and provoke a repetitive reply, or use the `MANA_VERIFY_REPLY`/`MANA_AUTO_RETRY_VERIFICATION` env vars) and confirm playback restarts cleanly on the corrected reply instead of speaking a stale draft.

- [ ] **Step 6: Commit**

```bash
git add windows-launcher/renderer/renderer.js
git commit -m "Consume streamed sentences for TTS pipelining in windows-launcher (#331)"
```

---

## Task 5: `desktop-client` — port the queue pattern and wire streaming

**Files:**
- Modify: `desktop-client/renderer/renderer.js`

**Interfaces:**
- Consumes: `POST /reply/stream` from Task 3, `readNdjsonEvents` (co-locate a copy in this file — the two renderer apps don't currently share a JS module between them per the earlier research pass, so duplicate rather than introduce a new shared-module build step for one function).
- Consumes (existing, unchanged): `stopLipSync()`/`startLipSync(audioCtx, sourceNode)` (`desktop-client/renderer/renderer.js:580-625`).
- Produces: `speakStreamingReply(requestBody)` — replaces the current `fetch("/reply") -> res.json() -> speakReply(json.reply)` flow at the two call sites (`:684`, `:1978`).

Before writing code, re-read the current `speakReply(replyText, preferredExpression)` (`:470-495`) and the two call sites in full — desktop-client has no chunking today (one reply = one `AudioContext`/`AudioBufferSourceNode`, no `splitReplyForSpeech` equivalent), so this task builds the queue pattern from scratch rather than refactoring an existing one, unlike Task 4.

- [ ] **Step 1: Add the NDJSON reader**

Same implementation as Task 4 Step 1 (`readNdjsonEvents`), added to `desktop-client/renderer/renderer.js`.

- [ ] **Step 2: Add a chunked-synthesis helper matching this app's audio API**

```js
// desktop-client uses AudioContext/AudioBufferSourceNode, not <audio>
// elements -- a BufferSourceNode's start() can only be called once ever,
// so a fresh node is created per chunk (same constraint speakReply's
// existing single-shot playback already works within, just repeated per
// chunk here instead of once per whole reply).
async function synthesizeAndDecodeChunk(text, audioCtx) {
  const response = await fetch("http://127.0.0.1:5005/synthesize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const arrayBuffer = await response.arrayBuffer();
  return audioCtx.decodeAudioData(arrayBuffer);
}

function playDecodedChunk(audioCtx, audioBuffer) {
  return new Promise((resolve) => {
    const src = audioCtx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(audioCtx.destination);
    src.onended = () => resolve();
    src.start();
    startLipSync(audioCtx, src);
  });
}
```

- [ ] **Step 3: Add the streaming chunk queue (ported from windows-launcher's Task 4 Step 2 shape)**

```js
// Same pushChunk/markDone/run shape as windows-launcher's
// createStreamingChunkQueue (Task 4), adapted to this app's
// synthesize-then-decode-then-play primitives instead of blob-based Audio
// elements. Kept as a near-duplicate rather than a shared module, matching
// how desktop-client and windows-launcher already each define their own
// stopLipSync/startLipSync rather than sharing one.
function createDesktopStreamingChunkQueue(playbackToken, audioCtx, isCurrentToken) {
  const pending = [];
  let waiter = null;
  let done = false;

  function pushChunk(text) {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve({ text, finished: false });
    } else {
      pending.push(text);
    }
  }

  function markDone() {
    done = true;
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve({ text: null, finished: true });
    }
  }

  async function nextChunk() {
    if (pending.length) return { text: pending.shift(), finished: false };
    if (done) return { text: null, finished: true };
    return new Promise((resolve) => { waiter = resolve; });
  }

  async function run() {
    let currentDecodePromise = null;
    for (;;) {
      if (!isCurrentToken(playbackToken)) return;
      if (!currentDecodePromise) {
        const { text, finished } = await nextChunk();
        if (finished) return;
        currentDecodePromise = synthesizeAndDecodeChunk(text, audioCtx);
      }
      const audioBuffer = await currentDecodePromise;
      if (!isCurrentToken(playbackToken)) return;
      const { text: nextText, finished: nextFinished } = await nextChunk();
      currentDecodePromise = nextFinished ? null : synthesizeAndDecodeChunk(nextText, audioCtx);
      await playDecodedChunk(audioCtx, audioBuffer);
      if (nextFinished && !currentDecodePromise) return;
    }
  }

  return { pushChunk, markDone, run };
}
```

- [ ] **Step 4: Add a `replyPlaybackToken` counter and `stopReplyAudio`-equivalent (this app has neither today)**

Add near wherever `speakReply` is defined:

```js
let desktopReplyPlaybackToken = 0;

function stopStreamingReply() {
  desktopReplyPlaybackToken += 1;
}
```

- [ ] **Step 5: Add `speakStreamingReply`**

```js
async function speakStreamingReply(requestBody) {
  const playbackToken = ++desktopReplyPlaybackToken;
  const isCurrentToken = (token) => desktopReplyPlaybackToken === token;
  const audioCtx = new AudioContext();
  const queue = createDesktopStreamingChunkQueue(playbackToken, audioCtx, isCurrentToken);
  const runPromise = queue.run();

  const response = await fetch('http://127.0.0.1:5005/reply/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  let finalEvent = null;
  for await (const event of readNdjsonEvents(response)) {
    if (!isCurrentToken(playbackToken)) break;
    if (event.type === 'sentence') {
      queue.pushChunk(event.text);
    } else if (event.type === 'final') {
      finalEvent = event;
    }
  }
  queue.markDone();
  await runPromise;

  if (!isCurrentToken(playbackToken)) {
    return finalEvent || { reply: '', ttsConfigured: false };
  }

  if (finalEvent && finalEvent.changed) {
    stopStreamingReply();
    if (finalEvent.reply) {
      await speakReply(finalEvent.reply, finalEvent.expression);
    }
  }

  return finalEvent || { reply: '', ttsConfigured: false };
}
```

- [ ] **Step 6: Wire the two call sites**

Read the current code around `desktop-client/renderer/renderer.js:684` (`onRecordingStop`) and `:1978` (`sendTextMessage`) — both currently do:

```js
const response = await fetch('http://127.0.0.1:5005/reply', { method: 'POST', headers: {...}, body: JSON.stringify({...}) });
const json = await response.json();
await speakReply(json.reply, json.expression);
```

Replace each with:

```js
const result = await speakStreamingReply(requestBodyObjectAlreadyBuiltAtThisCallSite);
// use result.reply / result.expression / result.ttsConfigured wherever json.reply etc. were used
```

Preserve the existing `try/finally` blocks at both sites unchanged (`setStatusIdle()`, `sendingTextMessage = false`, etc.).

- [ ] **Step 7: Manual test**

Use the `run` skill to start `desktop-client`, send a multi-sentence message via text input and via voice recording (both call sites), and confirm the same behavior verified in Task 4 Step 5: early audio start, gapless back-to-back chunk playback, correct final chat-log text, and clean cancel-and-restart on a forced `changed:true` case.

- [ ] **Step 8: Commit**

```bash
git add desktop-client/renderer/renderer.js
git commit -m "Port streaming chunk queue into desktop-client for TTS pipelining (#331)"
```

---

## Self-Review Notes

- **Spec coverage:** #331's scope items — "request streamed output from llama-server" (Task 2, via already-merged `streamLocalAssistantReply`), "cut the stream into sentences" (already merged, `sentence-chunker.js`), "fire TTS synthesis for each completed sentence... while the LLM keeps generating" (Tasks 2-3), "queue and play... with no audible gap" (Tasks 4-5), "extend lip-sync... so the mouth doesn't visibly freeze between sentences" (Tasks 4-5 keep the existing per-chunk `startLipSync`/`stopLipSync` calls, which the original research already found run back-to-back with no visible gap in windows-launcher's existing sequential-await design — no further lip-sync redesign needed). "Design the TTS-side call site so a provider can plug in... genuinely incremental/streaming synthesis... without a second rewrite later" is explicitly deferred (within-sentence Fish `streaming:true` audio is out of scope per Global Constraints) but this plan's chunk-queue shape (`pushChunk`/`markDone`/`run`) doesn't preclude a future chunk being fed by a streaming audio source instead of one blocking `/synthesize` call — that swap would happen inside `synthesizeSpeechChunk`/`synthesizeAndDecodeChunk` without touching the queue shape itself.
- **Placeholder scan:** Two spots intentionally left as "go read the existing test file and copy its shape" (Task 2 Step 1, Task 3 Step 1) rather than fabricated fake code, because the exact `deps`-stubbing convention used by this codebase's existing `node-bot/test/*.test.js` files wasn't verified during planning and guessing at it risks writing tests that don't match house style. This is flagged explicitly as the first sub-step of executing those tasks, not silently skipped.
- **Type consistency:** `onSentence(sentence: string) => void | Promise<void>` is consistent from `streamLocalAssistantReply` (existing) through `buildAssistantReply`'s new parameter, through the route's `writeEvent` callback. The client-side `{type, text}` / `{type, reply, ttsConfigured, changed, expression?}` event shapes are identical across Task 3 (producer) and Tasks 4-5 (consumers).
