const assert = require("node:assert/strict");
const test = require("node:test");

const { computeNGramSimilarity, createRutDetector } = require("../rut-detection");

test("computeNGramSimilarity scores identical text as 1 and unrelated text near 0", () => {
  assert.equal(computeNGramSimilarity("the quick brown fox jumps", "the quick brown fox jumps"), 1);
  assert.equal(computeNGramSimilarity("the quick brown fox", "completely different words entirely"), 0);
});

test("computeNGramSimilarity falls back to unigram overlap for very short text", () => {
  assert.ok(computeNGramSimilarity("hi there", "hi there") > 0);
});

test("computeNGramSimilarity is symmetric and handles empty input", () => {
  assert.equal(computeNGramSimilarity("", "something"), 0);
  assert.equal(computeNGramSimilarity("something", ""), 0);
  const a = computeNGramSimilarity("one two three four", "two three four five");
  const b = computeNGramSimilarity("two three four five", "one two three four");
  assert.equal(a, b);
});

test("checkReply flags a candidate highly similar to a recent reply as a rut", () => {
  const detector = createRutDetector({ similarityThreshold: 0.5 });
  const recent = ["I'd say that's a great question to explore further together!"];
  const result = detector.checkReply(
    "s1",
    "I'd say that's a great question to explore further together!",
    recent,
  );
  assert.equal(result.isRut, true);
  assert.equal(result.similarity, 1);
});

test("checkReply does not flag a genuinely different reply", () => {
  const detector = createRutDetector({ similarityThreshold: 0.5 });
  const recent = ["The weather today is sunny with a light breeze."];
  const result = detector.checkReply("s1", "Let's talk about your project deadline instead.", recent);
  assert.equal(result.isRut, false);
});

test("checkReply excludes trivially short replies and exact acknowledgements", () => {
  const detector = createRutDetector({ minMessageLength: 15 });
  const recent = ["okay", "yeah", "sure thing"];
  assert.equal(detector.checkReply("s1", "okay", recent).isRut, false);
  assert.equal(detector.checkReply("s1", "yeah", recent).isRut, false);
});

test("checkReply only compares against the configured lookback window", () => {
  const detector = createRutDetector({ lookback: 2, similarityThreshold: 0.5 });
  const recent = [
    "this exact phrase should be too old to matter for the lookback window",
    "a totally different filler reply here",
    "another totally different filler reply",
  ];
  const result = detector.checkReply(
    "s1",
    "this exact phrase should be too old to matter for the lookback window",
    recent,
  );
  assert.equal(result.isRut, false);
});

test("an intervention starts a cooldown that suppresses the next N checks", () => {
  const detector = createRutDetector({ similarityThreshold: 0.5, cooldownReplies: 2 });
  const recent = ["a familiar repeated sentence about the weather outside today"];
  const repeated = "a familiar repeated sentence about the weather outside today";

  const first = detector.checkReply("s1", repeated, recent);
  assert.equal(first.isRut, true);
  detector.recordIntervention("s1");

  const second = detector.checkReply("s1", repeated, recent);
  assert.equal(second.onCooldown, true);
  assert.equal(second.isRut, false);

  const third = detector.checkReply("s1", repeated, recent);
  assert.equal(third.onCooldown, true);

  const fourth = detector.checkReply("s1", repeated, recent);
  assert.equal(fourth.onCooldown, false);
  assert.equal(fourth.isRut, true);
});

test("cooldown is tracked per session, not globally", () => {
  const detector = createRutDetector({ similarityThreshold: 0.5, cooldownReplies: 5 });
  const recent = ["a repeated phrase about the ongoing weather situation outside"];
  const repeated = "a repeated phrase about the ongoing weather situation outside";

  detector.checkReply("session-a", repeated, recent);
  detector.recordIntervention("session-a");

  const otherSession = detector.checkReply("session-b", repeated, recent);
  assert.equal(otherSession.onCooldown, false);
  assert.equal(otherSession.isRut, true);
});

test("pickLeastRepetitive keeps the judge's pick when it isn't a rut", () => {
  const detector = createRutDetector({ similarityThreshold: 0.5 });
  const candidates = ["a fresh and different answer entirely", "another unique take on things"];
  const result = detector.pickLeastRepetitive("s1", candidates, 0, ["something else from before"]);
  assert.equal(result.switched, false);
  assert.equal(result.content, candidates[0]);
});

test("pickLeastRepetitive switches to a less-repetitive already-generated candidate", () => {
  const detector = createRutDetector({ similarityThreshold: 0.5 });
  const repeated = "I think that's a wonderful idea, let's explore it together";
  const candidates = [repeated, "Honestly, I'd take a completely different approach here"];
  const result = detector.pickLeastRepetitive("s1", candidates, 0, [repeated]);
  assert.equal(result.switched, true);
  assert.equal(result.index, 1);
  assert.equal(result.content, candidates[1]);
});

test("pickLeastRepetitive reports needsRegeneration when every candidate is a rut", () => {
  const detector = createRutDetector({ similarityThreshold: 0.5 });
  const repeated = "I think that's a wonderful idea, let's explore it together";
  const candidates = [repeated, repeated];
  const result = detector.pickLeastRepetitive("s1", candidates, 0, [repeated]);
  assert.equal(result.needsRegeneration, true);
  assert.equal(result.switched, false);
});

test("pickLeastRepetitive respects cooldown the same way checkReply does", () => {
  const detector = createRutDetector({ similarityThreshold: 0.5, cooldownReplies: 1 });
  detector.recordIntervention("s1");
  const candidates = ["anything", "anything else"];
  const result = detector.pickLeastRepetitive("s1", candidates, 0, []);
  assert.equal(result.onCooldown, true);
  assert.equal(result.content, candidates[0]);
});

test("isExcluded treats configured exclude keywords case-insensitively", () => {
  const detector = createRutDetector({ excludeKeywords: ["Nice"] });
  assert.equal(detector.isExcluded("nice"), true);
  assert.equal(detector.isExcluded("NICE"), true);
  assert.equal(detector.isExcluded("nice work on that"), false);
});
