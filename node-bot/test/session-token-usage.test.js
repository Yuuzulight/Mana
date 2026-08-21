const assert = require("node:assert/strict");
const test = require("node:test");

const { recordUsage, getUsage, resetSessionTokenUsage } = require("../session-token-usage");

test("getUsage returns zeros for a session with no recorded calls", () => {
  resetSessionTokenUsage();
  assert.deepEqual(getUsage("never-called"), {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    calls: 0,
  });
});

test("recordUsage accumulates prompt/completion tokens across multiple calls in the same session", () => {
  resetSessionTokenUsage();
  recordUsage("sess-1", { prompt_tokens: 100, completion_tokens: 20 });
  const after = recordUsage("sess-1", { prompt_tokens: 50, completion_tokens: 10 });

  assert.equal(after.promptTokens, 150);
  assert.equal(after.completionTokens, 30);
  assert.equal(after.totalTokens, 180);
  assert.equal(after.calls, 2);
});

test("recordUsage keeps separate sessions' totals independent", () => {
  resetSessionTokenUsage();
  recordUsage("sess-a", { prompt_tokens: 100, completion_tokens: 10 });
  recordUsage("sess-b", { prompt_tokens: 5, completion_tokens: 1 });

  assert.equal(getUsage("sess-a").totalTokens, 110);
  assert.equal(getUsage("sess-b").totalTokens, 6);
});

test("recordUsage treats a missing/malformed usage field as zero rather than throwing or recording NaN", () => {
  resetSessionTokenUsage();
  assert.doesNotThrow(() => recordUsage("sess-1", null));
  assert.doesNotThrow(() => recordUsage("sess-1", {}));
  assert.doesNotThrow(() => recordUsage("sess-1", { prompt_tokens: "not a number" }));

  const usage = getUsage("sess-1");
  assert.equal(Number.isNaN(usage.promptTokens), false);
  assert.equal(Number.isNaN(usage.totalTokens), false);
  assert.equal(usage.calls, 3);
});

test("resetSessionTokenUsage clears one session without touching others", () => {
  resetSessionTokenUsage();
  recordUsage("sess-a", { prompt_tokens: 100, completion_tokens: 10 });
  recordUsage("sess-b", { prompt_tokens: 5, completion_tokens: 1 });

  resetSessionTokenUsage("sess-a");

  assert.equal(getUsage("sess-a").totalTokens, 0);
  assert.equal(getUsage("sess-b").totalTokens, 6);
});

test("resetSessionTokenUsage with no argument clears every session", () => {
  recordUsage("sess-a", { prompt_tokens: 100, completion_tokens: 10 });
  recordUsage("sess-b", { prompt_tokens: 5, completion_tokens: 1 });

  resetSessionTokenUsage();

  assert.equal(getUsage("sess-a").totalTokens, 0);
  assert.equal(getUsage("sess-b").totalTokens, 0);
});
