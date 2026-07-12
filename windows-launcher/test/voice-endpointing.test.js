const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_MAX_UTTERANCE_MS,
  DEFAULT_MAX_WAIT_FOR_SPEECH_MS,
  DEFAULT_SILENCE_BUFFER_MS,
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
