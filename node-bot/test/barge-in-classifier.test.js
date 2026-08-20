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

test("amend-shaped clarifications classify as amend, ahead of correction's overlapping keywords", () => {
  // "no" alone is a correction keyword, but "the other" wins since amend is
  // checked first.
  assert.equal(classifyBargeIn("no, the other file").category, "amend");
  assert.equal(classifyBargeIn("not that one, the other one").category, "amend");
  assert.equal(classifyBargeIn("not this file").category, "amend");
});

test("amend's keyword list does not regress the existing correction case it could have collided with", () => {
  // "that's not what I meant" contains neither "the other" nor "not that"
  // nor "not this" -- this must keep classifying as correction, unchanged
  // from #339/#340's shipped behavior.
  assert.equal(classifyBargeIn("wait, that's not what I meant").category, "correction");
});

test("short keywords like 'no'/'ok' match as whole words, not substrings of unrelated words", () => {
  assert.equal(classifyBargeIn("what time is it now").category, "new_question");
  assert.equal(classifyBargeIn("do you know what time it is").category, "new_question");
  // "tell me a joke" is 4 words, so once the false "ok"-in-"joke" match is
  // removed it falls through to the length-based default (Fix 3) as
  // new_question, rather than the old wrong "backchannel".
  assert.equal(classifyBargeIn("tell me a joke").category, "new_question");
  assert.equal(classifyBargeIn("i broke it").category, "unclassified");
});

test("unclassified fallback routes by length: short stays unclassified (resume), longer is treated as a question (answer then resume)", () => {
  assert.equal(classifyBargeIn("banana pancakes").category, "unclassified");
  // "okay yeah" matches the "yeah" backchannel keyword directly (a
  // pre-existing match, not the new fallback path); "sounds good" matches
  // no keyword list and exercises the new <=3-word fallback branch itself.
  assert.equal(classifyBargeIn("sounds good").category, "unclassified");
  assert.equal(classifyBargeIn("tell me a joke").category, "new_question");
  assert.equal(classifyBargeIn("i broke it just now").category, "new_question");
});
