const assert = require("node:assert");
const { test } = require("node:test");
const { streamedMatchesFinal } = require("../utils/reply-stream-diff");

test("matches when final reply is exactly the joined streamed sentences", () => {
  assert.strictEqual(
    streamedMatchesFinal(["Hello there.", "How can I help?"], "Hello there. How can I help?"),
    true,
  );
});

test("does not match when final reply diverges (regen/rewrite changed it)", () => {
  assert.strictEqual(
    streamedMatchesFinal(["Hello there."], "Hi! What's up?"),
    false,
  );
});

test("does not match when nothing streamed (tool-aware/best-of-N path)", () => {
  assert.strictEqual(streamedMatchesFinal([], "Some reply from a tool call."), false);
});

test("tolerates surrounding whitespace differences", () => {
  assert.strictEqual(
    streamedMatchesFinal(["One.", "Two."], "  One. Two.  \n"),
    true,
  );
});
