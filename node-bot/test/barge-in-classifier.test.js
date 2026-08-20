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
