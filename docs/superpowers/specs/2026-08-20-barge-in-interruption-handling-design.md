# Barge-in interruption handling (Sub-project B, #339 / #340)

## Context

Sub-project A (already merged) ported continuous listening and a basic
barge-in monitor into `desktop-client`, matching `windows-launcher`'s
existing behavior. In both apps today, a barge-in trigger
(`nextBargeInState` in `voice-endpointing.js`, fired from each app's
`watchForBargeIn`) does **stop-and-discard only**: it stops the currently
playing reply audio and nothing else. The interrupting utterance is then
picked up as an ordinary new turn once the normal continuous-listening
loop (`listenLoop` → `recordUntilSilence`) happens to cycle around to it.

This sub-project replaces stop-and-discard with **stop → hold → classify →
resume/discard/insert**: the held reply's remaining text can be resumed,
discarded, or set aside while an inserted answer plays, depending on what
the interruption actually was.

Explicitly out of scope (per earlier project-level decision): aborting the
in-flight LLM generation on barge-in. Generation keeps running regardless
of what happens to playback/held state — this sub-project only changes
what happens to already-generated reply *text* and its *playback*, not the
generation call itself.

## Flow

1. Barge-in triggers (VAD + hold-timer + loudness gate, see below) →
   playback stops immediately, exactly as today.
2. The reply's remaining not-yet-played sentences are captured into a
   held-reply slot instead of being discarded.
3. A dedicated recording starts immediately (not waiting for
   `listenLoop`'s next cycle) to capture just the interruption.
4. Once transcribed, the transcript is classified into one of four
   categories via a new backend endpoint.
5. The app acts on the category:
   - **backchannel** ("mhm", "okay") or **unclassified** → resume the held
     reply from the cut point. No new turn is created.
   - **correction/stop** ("wait", "no", "never mind") → discard the held
     reply; feed the transcript into the normal `/reply`(`-stream`)
     pipeline as a fresh turn (today's existing behavior).
   - **new-question** → feed the transcript in as a fresh turn, play that
     answer to completion, then resume the held reply.
6. Nesting cap: if a second interruption occurs while an inserted
   new-question answer is playing (i.e. a held reply is already parked
   underneath one), the held reply is discarded and the second
   interruption is handled as a fresh top-level turn. Held state never
   stacks more than one deep.

## Components

### 1. Energy/loudness gate (#340) — `voice-endpointing.js` (both apps)

`nextBargeInState` gains an `isLoudEnough` parameter. The hold countdown
(`speechStartedAt`) only starts or continues when `isSpeech &&
isLoudEnough`; otherwise it resets exactly like `!isSpeech` does today.
This filters out quiet room noise/breath that Silero VAD sometimes
false-positives on, without changing the existing 350ms hold semantics.

A new exported constant, `DEFAULT_BARGE_IN_MIN_DBFS = -45`, sets the
loudness floor, alongside `voice-endpointing.js`'s existing `DEFAULT_*`
constants — -45 dBFS sits above typical mic room-noise floor (-50 to -60
dBFS) and below normal speech level (-20 to -30 dBFS), tunable without
redeploying since it's a plain exported constant.

Each app's `watchForBargeIn` computes dBFS from the same
`analyser.getFloatTimeDomainData(samples)` frame already sampled for VAD
— no new audio pipeline, no new mic access.

Since `voice-endpointing.js` is duplicated per-app (ported verbatim in
Sub-project A, not shared via `require()` across the `nodeIntegration`
boundary), this change lands in both copies, and both existing test files
(`windows-launcher/test/voice-endpointing.test.js`,
`desktop-client/test/voice-endpointing.test.js`) get the same new cases.

### 2. Backend classifier — `node-bot/utils/barge-in-classifier.js`

New module, matching `intent-classifier.js`'s established style (ordered
keyword lists, `.includes()` checks, explicit fallback):

```js
function classifyBargeIn(text) {
  // 1. correction/stop keywords (fast-path, checked first):
  //    "wait", "stop", "hold on", "no", "nevermind", "never mind", "actually"
  // 2. new-question heuristic: starts with a question word
  //    (what/why/how/when/where/who/can/could/do/does/is/are) or the
  //    trimmed text ends in "?"
  // 3. backchannel keywords:
  //    "mhm", "yeah", "okay", "ok", "right", "uh huh", "got it", "sure", "cool"
  // 4. default: unclassified
}
```

Returns `{ category, reason }`, mirroring `classifyIntent`'s return shape.

### 3. Backend endpoint — `POST /barge-in/classify`

Follows `/debug/intent`'s exact pattern in `server.js` (validate `text` is
a non-empty string, 400 on bad input, call the classifier, return
`{success, category, reason, input_length}`). This is a real endpoint the
renderers call live during playback, not a debug-only route.

### 4. Held-state + resume/discard/insert — renderer.js (both apps)

A module-scope `heldReply = { sentences: [], stackDepth: 0 }` slot, at the
same scoping tier as today's `currentChunkSource`/`currentReplyAudio`.

- **Capture**: on trigger, `watchForBargeIn`'s `onTrigger` stops playback
  (unchanged) and additionally pulls the streaming-chunk-queue's
  not-yet-played sentence texts into `heldReply.sentences`.
- **Dedicated capture**: `onTrigger` also starts `recordUntilSilence()`
  immediately for the interruption, guarded so `listenLoop`'s own next
  cycle doesn't race it and double-record.
- **Resume**: feeds `heldReply.sentences` back through the same
  synthesize→play loop `speakStreamingReply`/`playReplyAudio` already use
  — a second entry point into the existing chunk-queue machinery, not a
  new playback primitive. Text only is held; audio is re-synthesized on
  resume.
- **Discard**: clears `heldReply`, hands the transcript to the existing
  `handleTranscript`/send-message path exactly like a normal new turn.
- **Insert**: if `heldReply.stackDepth` is already 1, this interruption is
  handled as discard instead (per the nesting cap). Otherwise, set
  `stackDepth = 1`, play the new-question's answer to completion via the
  normal path, then resume and reset `stackDepth = 0`.

## Testing

- `classifyBargeIn`: new unit test file matching
  `intent-classifier.test.js`'s style — coverage for all four categories
  plus the fast-path keyword cases.
- `nextBargeInState`'s new `isLoudEnough` param: new cases added to both
  apps' existing `voice-endpointing.test.js`.
- The renderer-side state machine (capture/hold/resume/discard/insert)
  isn't unit-testable, same as today's barge-in monitor — verified via
  final review and live manual testing, consistent with how Sub-project A
  was validated.

## Explicitly out of scope

- Aborting in-flight LLM generation on barge-in (generation keeps running
  regardless of playback/held state).
- Nested held state beyond depth 1.
- Caching already-synthesized audio across a hold (text-only held state;
  resume re-synthesizes).
