const assert = require("node:assert/strict");
const test = require("node:test");

const { createThinkFilter } = require("../utils/think-filter");

function streamChars(filter, text) {
  let out = "";
  for (const char of text) out += filter.push(char);
  return out + filter.flush();
}

test("passes text through when there is no think block", () => {
  const filter = createThinkFilter();
  assert.equal(streamChars(filter, "Hello there."), "Hello there.");
});

test("drops a think block entirely", () => {
  const filter = createThinkFilter();
  assert.equal(
    streamChars(filter, "Before <think>secret reasoning</think> after"),
    "Before  after",
  );
});

test("drops a think block split across deltas", () => {
  const filter = createThinkFilter();
  let out = "";
  // The tag itself arrives in pieces, which is what a token stream does and
  // what a regex over the complete text would never have to handle.
  out += filter.push("Before <thi");
  out += filter.push("nk>hidden");
  out += filter.push(" more hidden</thi");
  out += filter.push("nk> after");
  out += filter.flush();
  assert.equal(out, "Before  after");
});

test("never leaks reasoning before the closing tag arrives", () => {
  const filter = createThinkFilter();
  const emitted = filter.push("<think>this must never be spoken");
  // The whole point: by the time the closing tag lands, unfiltered text
  // would already have been cut into sentences and sent to TTS.
  assert.equal(emitted, "");
});

test("handles several think blocks in one stream", () => {
  const filter = createThinkFilter();
  assert.equal(
    streamChars(filter, "A<think>x</think>B<think>y</think>C"),
    "ABC",
  );
});

test("drops an unclosed think block at flush", () => {
  const filter = createThinkFilter();
  let out = filter.push("Visible <think>never closed");
  out += filter.flush();
  assert.equal(out, "Visible ");
});

test("text that merely looks like the start of a tag is released at flush", () => {
  const filter = createThinkFilter();
  let out = filter.push("compare a < b and");
  out += filter.flush();
  assert.equal(out, "compare a < b and");
});
