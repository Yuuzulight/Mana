const assert = require("node:assert/strict");
const test = require("node:test");

const { significantWords, sharedWordCount } = require("../utils/word-overlap");

test("significantWords lowercases, tokenizes, dedups, and filters out short words", () => {
  assert.deepEqual(significantWords("The Quick brown FOX jumps"), ["quick", "brown", "jumps"]);
  assert.deepEqual(significantWords("cat cat cat"), []); // "cat" is exactly 3 chars, filtered
  assert.deepEqual(significantWords(""), []);
  assert.deepEqual(significantWords(null), []);
});

test("sharedWordCount counts words present in both lists", () => {
  assert.equal(sharedWordCount(["alpha", "beta", "gamma"], ["beta", "gamma", "delta"]), 2);
  assert.equal(sharedWordCount([], ["beta"]), 0);
  assert.equal(sharedWordCount(["alpha"], []), 0);
});
