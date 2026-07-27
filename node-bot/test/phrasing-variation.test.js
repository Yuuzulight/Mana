const assert = require("node:assert/strict");
const test = require("node:test");

const {
  findLexiconMatch,
  createPhrasingVariator,
  rewritePhrase,
} = require("../phrasing-variation");

test("findLexiconMatch detects a known opener", () => {
  const match = findLexiconMatch("Mou, you really shouldn't have done that.");
  assert.equal(match.id, "mou-opener");
  assert.match(match.matchedText, /mou/i);
});

test("findLexiconMatch detects a known kaomoji", () => {
  const match = findLexiconMatch("Sure, I can help with that (＾▽＾)");
  assert.equal(match.id, "kaomoji-happy");
});

test("findLexiconMatch returns null when nothing in the lexicon matches", () => {
  assert.equal(findLexiconMatch("Here's the fix for your bug."), null);
});

test("checkReply is not predictable the first time a catchphrase appears", () => {
  const variator = createPhrasingVariator();
  const result = variator.checkReply("s1", "Hmph, fine, I'll help you with it.");
  assert.equal(result.isPredictable, false);
  assert.equal(result.match.id, "hmph-opener");
});

test("checkReply flags a catchphrase reused within the lookback window", () => {
  const variator = createPhrasingVariator({ lookback: 3 });
  variator.recordUsage("s1", "hmph-opener");
  const result = variator.checkReply("s1", "Hmph, okay, let's get started.");
  assert.equal(result.isPredictable, true);
  assert.equal(result.match.id, "hmph-opener");
});

test("checkReply does not flag a catchphrase that fell outside the lookback window", () => {
  const variator = createPhrasingVariator({ lookback: 2 });
  variator.recordUsage("s1", "hmph-opener");
  variator.recordUsage("s1", "geez-opener");
  variator.recordUsage("s1", "fufu-opener");
  const result = variator.checkReply("s1", "Hmph, sure, whatever you say.");
  assert.equal(result.isPredictable, false);
});

test("checkReply history is tracked per session, not globally", () => {
  const variator = createPhrasingVariator({ lookback: 3 });
  variator.recordUsage("session-a", "hmph-opener");
  const other = variator.checkReply("session-b", "Hmph, alright then.");
  assert.equal(other.isPredictable, false);
});

test("a genuinely varied reply with no catchphrase passes through untouched", () => {
  const variator = createPhrasingVariator();
  variator.recordUsage("s1", "hmph-opener");
  const result = variator.checkReply("s1", "Here's the answer you were looking for.");
  assert.equal(result.isPredictable, false);
  assert.equal(result.match, null);
});

test("rewritePhrase asks the injected synthesize function and strips wrapping quotes", async () => {
  let receivedPrompt = null;
  const synthesize = async (prompt) => {
    receivedPrompt = prompt;
    return '"Ugh, fine."';
  };
  const alt = await rewritePhrase("Hmph, fine.", { synthesize });
  assert.equal(alt, "Ugh, fine.");
  assert.match(receivedPrompt, /Hmph, fine\./);
});

test("rewritePhrase requires a synthesize function", async () => {
  await assert.rejects(() => rewritePhrase("text", {}), /synthesize is required/);
});
