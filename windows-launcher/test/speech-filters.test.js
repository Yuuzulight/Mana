const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MAX_HALLUCINATION_AUDIO_SECONDS,
  WHISPER_HALLUCINATION_PHRASES,
  isLikelyWhisperHallucination,
  levenshteinDistance,
  fuzzyMatchesWakeWord,
  computeGainFactor,
  getSpeechRejectReason,
} = require("../renderer/speech-filters");

// Issue #4's "small local test harness ... to compare recognition changes"
// -- real recorded WAV fixtures aren't available in this environment, so
// this synthesizes the same rms/peak/zeroCrossingRate stats a real clip
// would produce (a sine wave for "speech", near-silence, and a
// high-frequency buzz for "clicky" noise) and runs them through the exact
// same reject-decision logic renderer.js uses.
function synthesizeStats({ amplitude, frequency, sampleRate = 16000, seconds = 1 }) {
  const length = Math.floor(sampleRate * seconds);
  let sumSquares = 0;
  let peak = 0;
  let zeroCrossings = 0;
  let previous = 0;
  for (let i = 0; i < length; i++) {
    const sample = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
    sumSquares += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
    if ((previous < 0 && sample >= 0) || (previous >= 0 && sample < 0)) zeroCrossings += 1;
    previous = sample;
  }
  return {
    rms: Math.sqrt(sumSquares / length),
    peak,
    zeroCrossingRate: zeroCrossings / length,
  };
}

const THRESHOLDS = { minRms: 0.012, minPeak: 0.04, maxClickyZcr: 0.28 };

test("getSpeechRejectReason accepts a normal-volume, speech-frequency synthetic signal", () => {
  const stats = synthesizeStats({ amplitude: 0.3, frequency: 200 }); // typical voice fundamental range
  assert.equal(getSpeechRejectReason(stats, THRESHOLDS), null);
});

test("getSpeechRejectReason rejects a near-silent synthetic signal as quiet", () => {
  const stats = synthesizeStats({ amplitude: 0.001, frequency: 200 });
  assert.equal(getSpeechRejectReason(stats, THRESHOLDS), "quiet");
});

test("getSpeechRejectReason rejects a high-frequency buzz as clicky", () => {
  // A much higher frequency than speech crosses zero far more often per
  // sample window -- the same signature a keyboard click's sharp transient
  // produces, which is what MAX_CLICKY_ZERO_CROSSING_RATE is gating.
  const stats = synthesizeStats({ amplitude: 0.3, frequency: 4000 });
  assert.equal(getSpeechRejectReason(stats, THRESHOLDS), "clicky");
});

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

test("levenshteinDistance counts single-edit differences correctly", () => {
  assert.equal(levenshteinDistance("mana", "mana"), 0);
  assert.equal(levenshteinDistance("mana", "manaa"), 1); // insertion
  assert.equal(levenshteinDistance("mana", "man"), 1); // deletion
  assert.equal(levenshteinDistance("mana", "mona"), 1); // substitution
  assert.equal(levenshteinDistance("mana", "banana"), 3);
});

const WAKE_WORDS_FIXTURE = ["mana", "manah", "manna", "mannah", "myna", "wake up"];

test("fuzzyMatchesWakeWord catches a single-letter mis-transcription", () => {
  assert.equal(fuzzyMatchesWakeWord("manaa", WAKE_WORDS_FIXTURE), true);
  assert.equal(fuzzyMatchesWakeWord("mona", WAKE_WORDS_FIXTURE), true);
  assert.equal(fuzzyMatchesWakeWord("man", WAKE_WORDS_FIXTURE), true);
});

test("fuzzyMatchesWakeWord rejects words too far from any wake word", () => {
  assert.equal(fuzzyMatchesWakeWord("banana", WAKE_WORDS_FIXTURE), false);
  assert.equal(fuzzyMatchesWakeWord("hello", WAKE_WORDS_FIXTURE), false);
  assert.equal(fuzzyMatchesWakeWord("", WAKE_WORDS_FIXTURE), false);
});

test("fuzzyMatchesWakeWord never fuzzy-matches against multi-word phrases", () => {
  // "wake" alone is edit-distance 3 from "wake up" as a whole string, but
  // multi-word entries are skipped entirely, not string-compared as-is.
  assert.equal(fuzzyMatchesWakeWord("wake", WAKE_WORDS_FIXTURE), false);
});

test("computeGainFactor boosts a quiet peak up toward the target, capped at maxBoost", () => {
  assert.equal(computeGainFactor(0.05, 0.2, 6), 4); // 0.2 / 0.05 = 4, under cap
  assert.equal(computeGainFactor(0.01, 0.2, 6), 6); // 0.2 / 0.01 = 20, capped at 6
});

test("computeGainFactor is a no-op for silence or an already-loud clip", () => {
  assert.equal(computeGainFactor(0, 0.2, 6), 1);
  assert.equal(computeGainFactor(0.3, 0.2, 6), 1); // already above target
  assert.equal(computeGainFactor(0.05, 0, 6), 1); // gain disabled (targetPeak 0)
});
