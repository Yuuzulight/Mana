const assert = require("node:assert/strict");
const test = require("node:test");

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

test("keeps recording while the user is still talking", () => {
  assert.equal(
    shouldStopRecording({
      hasHeardSpeech: true,
      elapsedMs: 5000,
      msSinceLastSpeech: 300, // still speaking, well under the silence buffer
    }),
    null,
  );
});

test("stops once silence has lasted the full buffer after speech", () => {
  assert.equal(
    shouldStopRecording({
      hasHeardSpeech: true,
      elapsedMs: 6000,
      msSinceLastSpeech: DEFAULT_SILENCE_BUFFER_MS,
    }),
    "silence-after-speech",
  );
  // One tick before the buffer elapses, it should not stop yet.
  assert.equal(
    shouldStopRecording({
      hasHeardSpeech: true,
      elapsedMs: 6000,
      msSinceLastSpeech: DEFAULT_SILENCE_BUFFER_MS - 1,
    }),
    null,
  );
});

test("a long sentence spanning many seconds is not cut off early", () => {
  // Simulates continuous speech (silence never accumulates) well past what
  // used to be the old fixed 3.5s/5s chunk duration.
  for (let elapsedMs = 0; elapsedMs <= 12000; elapsedMs += 500) {
    assert.equal(
      shouldStopRecording({
        hasHeardSpeech: true,
        elapsedMs,
        msSinceLastSpeech: 100,
      }),
      null,
      `should still be recording at elapsedMs=${elapsedMs}`,
    );
  }
});

test("gives up if no speech is ever detected", () => {
  assert.equal(
    shouldStopRecording({
      hasHeardSpeech: false,
      elapsedMs: DEFAULT_MAX_WAIT_FOR_SPEECH_MS,
      msSinceLastSpeech: 0,
    }),
    "no-speech-timeout",
  );
  assert.equal(
    shouldStopRecording({
      hasHeardSpeech: false,
      elapsedMs: DEFAULT_MAX_WAIT_FOR_SPEECH_MS - 1,
      msSinceLastSpeech: 0,
    }),
    null,
  );
});

test("the max-duration safety cap wins even if still speaking", () => {
  assert.equal(
    shouldStopRecording({
      hasHeardSpeech: true,
      elapsedMs: DEFAULT_MAX_UTTERANCE_MS,
      msSinceLastSpeech: 50,
    }),
    "max-duration",
  );
});

test("custom silence buffer and timeouts are respected", () => {
  assert.equal(
    shouldStopRecording({
      hasHeardSpeech: true,
      elapsedMs: 1000,
      msSinceLastSpeech: 500,
      silenceBufferMs: 500,
    }),
    "silence-after-speech",
  );
  assert.equal(
    shouldStopRecording({
      hasHeardSpeech: false,
      elapsedMs: 3000,
      msSinceLastSpeech: 0,
      maxWaitForSpeechMs: 3000,
    }),
    "no-speech-timeout",
  );
});

// Issue #219 phase 2: barge-in-while-Mana-speaks hold-time gating.
test("nextBargeInState does not trigger on a single speech-positive frame", () => {
  const state = nextBargeInState({
    isSpeech: true,
    speechStartedAt: null,
    now: 1000,
  });
  assert.equal(state.triggered, false);
  assert.equal(state.speechStartedAt, 1000);
});

test("nextBargeInState triggers once speech has held for the full duration", () => {
  const first = nextBargeInState({ isSpeech: true, speechStartedAt: null, now: 1000 });
  const stillHolding = nextBargeInState({
    isSpeech: true,
    speechStartedAt: first.speechStartedAt,
    now: 1000 + DEFAULT_BARGE_IN_HOLD_MS - 1,
  });
  assert.equal(stillHolding.triggered, false);

  const triggered = nextBargeInState({
    isSpeech: true,
    speechStartedAt: first.speechStartedAt,
    now: 1000 + DEFAULT_BARGE_IN_HOLD_MS,
  });
  assert.equal(triggered.triggered, true);
});

test("nextBargeInState resets on a gap, so an echo blip can't accumulate toward the hold time", () => {
  const first = nextBargeInState({ isSpeech: true, speechStartedAt: null, now: 1000 });
  const gap = nextBargeInState({ isSpeech: false, speechStartedAt: first.speechStartedAt, now: 1100 });
  assert.equal(gap.speechStartedAt, null);
  assert.equal(gap.triggered, false);

  // Even well past the original start time, a fresh speech run must restart the clock.
  const resumed = nextBargeInState({
    isSpeech: true,
    speechStartedAt: gap.speechStartedAt,
    now: 1000 + DEFAULT_BARGE_IN_HOLD_MS,
  });
  assert.equal(resumed.triggered, false);
  assert.equal(resumed.speechStartedAt, 1000 + DEFAULT_BARGE_IN_HOLD_MS);
});

test("nextBargeInState respects a custom holdMs", () => {
  const first = nextBargeInState({ isSpeech: true, speechStartedAt: null, now: 0, holdMs: 100 });
  const triggered = nextBargeInState({
    isSpeech: true,
    speechStartedAt: first.speechStartedAt,
    now: 100,
    holdMs: 100,
  });
  assert.equal(triggered.triggered, true);
});

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
