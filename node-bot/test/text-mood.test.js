const assert = require("node:assert/strict");
const test = require("node:test");

const { detectTextMood, detectTextValence } = require("../utils/text-mood");

test("detectTextMood recognizes an emoji mood", () => {
  assert.equal(detectTextMood("I'm so happy right now 😊"), "smile");
});

test("detectTextMood recognizes a kaomoji mood", () => {
  assert.equal(detectTextMood("(T_T) that's so sad"), "sniff");
});

test("detectTextMood returns null for plain text with no signal", () => {
  assert.equal(detectTextMood("what time is the meeting tomorrow"), null);
});

test("detectTextValence maps a positive emoji mood to 1", () => {
  assert.equal(detectTextValence("this is great! 🎉"), 1);
});

test("detectTextValence maps a negative kaomoji mood to -1", () => {
  assert.equal(detectTextValence("(T_T) I failed the exam"), -1);
});

test("detectTextValence falls back to keyword detection when there's no emoji/kaomoji", () => {
  assert.equal(detectTextValence("this is awesome, finally!"), 1);
  assert.equal(detectTextValence("ugh, that's so annoying"), -1);
});

test("detectTextValence returns 0 for neutral or ambiguous text", () => {
  assert.equal(detectTextValence("what time is the meeting tomorrow"), 0);
  assert.equal(detectTextValence(""), 0);
});
