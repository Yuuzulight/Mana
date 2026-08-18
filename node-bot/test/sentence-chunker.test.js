const assert = require("node:assert/strict");
const test = require("node:test");

const { createSentenceChunker } = require("../utils/sentence-chunker");

// Feeds text one character at a time, which is the worst case a token
// stream can produce and the one most likely to break a naive splitter.
function pushCharByChar(chunker, text) {
  const out = [];
  for (const char of text) out.push(...chunker.push(char));
  return out;
}

test("emits a sentence once its terminator is confirmed", () => {
  const chunker = createSentenceChunker();
  assert.deepEqual(chunker.push("Hello there"), []);
  // The terminator alone is not enough -- it could still be a decimal.
  assert.deepEqual(chunker.push("."), []);
  assert.deepEqual(chunker.push(" And more"), ["Hello there."]);
});

test("never emits a partial sentence mid-stream", () => {
  const chunker = createSentenceChunker();
  const emitted = pushCharByChar(chunker, "This is a complete thought. ");
  assert.deepEqual(emitted, ["This is a complete thought."]);
  // Half a sentence sent to TTS cannot be taken back once it is playing.
  assert.equal(chunker.pending().trim(), "");
});

test("splits a multi-sentence delta into all of them", () => {
  const chunker = createSentenceChunker();
  const out = chunker.push("One. Two! Three? ");
  assert.deepEqual(out, ["One.", "Two!", "Three?"]);
});

test("does not split a decimal number", () => {
  const chunker = createSentenceChunker();
  assert.deepEqual(pushCharByChar(chunker, "Pi is 3.14 roughly. "), ["Pi is 3.14 roughly."]);
});

test("does not split on a common abbreviation", () => {
  const chunker = createSentenceChunker();
  assert.deepEqual(pushCharByChar(chunker, "Ask Dr. Smith about it. "), [
    "Ask Dr. Smith about it.",
  ]);
});

test("keeps a run of terminators together", () => {
  const chunker = createSentenceChunker();
  assert.deepEqual(chunker.push("Really?! Yes... Fine. "), ["Really?!", "Yes...", "Fine."]);
});

test("breaks run-on text at the cap without splitting a word", () => {
  const chunker = createSentenceChunker({ maxChars: 40 });
  const out = chunker.push("alpha bravo charlie delta echo foxtrot golf hotel india ");
  assert.ok(out.length >= 1);
  for (const sentence of out) {
    assert.ok(sentence.length <= 40, `"${sentence}" exceeded the cap`);
    // A word split down the middle is audibly wrong in a way an early
    // break is not.
    assert.ok(!/\S$/.test(sentence) || /^[a-z]+$/i.test(sentence.split(" ").pop()));
  }
});

test("flush returns unpunctuated trailing text", () => {
  const chunker = createSentenceChunker();
  chunker.push("A finished one. And a trailing thought with no period");
  assert.deepEqual(chunker.flush(), ["And a trailing thought with no period"]);
  assert.deepEqual(chunker.flush(), []);
});

test("an empty stream produces nothing", () => {
  const chunker = createSentenceChunker();
  assert.deepEqual(chunker.push(""), []);
  assert.deepEqual(chunker.flush(), []);
});

test("whitespace between sentences is not emitted as a sentence", () => {
  const chunker = createSentenceChunker();
  const out = chunker.push("Done.    \n\n   Next one. ");
  assert.deepEqual(out, ["Done.", "Next one."]);
});
