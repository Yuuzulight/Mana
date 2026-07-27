const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MAX_HALLUCINATION_AUDIO_SECONDS,
  WHISPER_HALLUCINATION_PHRASES,
  isLikelyWhisperHallucination,
} = require("../renderer/speech-filters");

test("isLikelyWhisperHallucination flags a known phantom phrase from a very short clip", () => {
  assert.equal(isLikelyWhisperHallucination("thank you", 0.8), true);
  assert.equal(isLikelyWhisperHallucination("thanks for watching", 1.2), true);
  assert.equal(isLikelyWhisperHallucination("please subscribe", 2.0), true);
});

test("isLikelyWhisperHallucination does not flag the same wording from a longer clip", () => {
  assert.equal(isLikelyWhisperHallucination("thank you", 4), false);
  assert.equal(
    isLikelyWhisperHallucination("thank you", MAX_HALLUCINATION_AUDIO_SECONDS + 0.01),
    false,
  );
});

test("isLikelyWhisperHallucination does not flag real speech regardless of duration", () => {
  assert.equal(isLikelyWhisperHallucination("what time is it", 1), false);
  assert.equal(isLikelyWhisperHallucination("mana can you help me", 2), false);
});

test("isLikelyWhisperHallucination requires a numeric duration", () => {
  assert.equal(isLikelyWhisperHallucination("thank you", undefined), false);
  assert.equal(isLikelyWhisperHallucination("thank you", null), false);
  assert.equal(isLikelyWhisperHallucination("thank you", "1.5"), false);
});

test("every entry in WHISPER_HALLUCINATION_PHRASES is flagged within the duration threshold", () => {
  for (const phrase of WHISPER_HALLUCINATION_PHRASES) {
    assert.equal(
      isLikelyWhisperHallucination(phrase, MAX_HALLUCINATION_AUDIO_SECONDS),
      true,
      `expected "${phrase}" to be flagged at the threshold duration`,
    );
  }
});
