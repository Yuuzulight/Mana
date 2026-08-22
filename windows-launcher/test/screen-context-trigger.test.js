const assert = require("node:assert/strict");
const test = require("node:test");

const { SCREEN_CONTEXT_KEYWORDS, shouldReadScreenForCommand } = require("../renderer/screen-context-trigger");

test("with the keyword gate enabled and not gaming, only keyword matches trigger a read", () => {
  assert.equal(
    shouldReadScreenForCommand("what does this error say", { gamingModeActive: false, keywordGateEnabled: true }),
    true,
  );
  assert.equal(
    shouldReadScreenForCommand("what's the weather like today", {
      gamingModeActive: false,
      keywordGateEnabled: true,
    }),
    false,
  );
});

test("with the keyword gate disabled and not gaming, every command triggers a read (old default)", () => {
  assert.equal(
    shouldReadScreenForCommand("what's the weather like today", {
      gamingModeActive: false,
      keywordGateEnabled: false,
    }),
    true,
  );
});

test("gaming mode always applies the keyword gate, regardless of the toggle", () => {
  assert.equal(
    shouldReadScreenForCommand("what's the weather like today", {
      gamingModeActive: true,
      keywordGateEnabled: false,
    }),
    false,
  );
  assert.equal(
    shouldReadScreenForCommand("check the quest map", { gamingModeActive: true, keywordGateEnabled: false }),
    true,
  );
});

test("defaults to gate-enabled, non-gaming when options are omitted", () => {
  assert.equal(shouldReadScreenForCommand("read this for me"), true);
  assert.equal(shouldReadScreenForCommand("tell me a joke"), false);
});

test("keyword list covers the issue's own motivating examples", () => {
  for (const phrase of ["what does this error say", "what's on screen", "read this"]) {
    assert.equal(
      SCREEN_CONTEXT_KEYWORDS.some((keyword) => phrase.includes(keyword)),
      true,
      `expected a keyword match in: ${phrase}`,
    );
  }
});
