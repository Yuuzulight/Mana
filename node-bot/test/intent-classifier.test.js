const test = require("node:test");
const assert = require("node:assert");
const { classifyIntent } = require("../utils/intent-classifier");

test("Dynamic Intent Classifier Suite - Object Verification", async (t) => {
  await t.test("should route technical file strings to coding mode", () => {
    const res = classifyIntent("Can you inspect C:\\ManaAI\\Mana\\server.js?");
    assert.strictEqual(res.mode, "coding");
    assert.match(res.reason, /matched_path_pattern/);
  });

  await t.test("should route code debugging keywords to coding mode", () => {
    const res = classifyIntent("Fix this broken json regex loop");
    assert.strictEqual(res.mode, "coding");
    assert.match(res.reason, /matched_dev_keyword/);
  });

  await t.test(
    "should route utility action words to everyday assistant mode",
    () => {
      const res = classifyIntent("Summarize this long email thread for me");
      assert.strictEqual(res.mode, "everyday");
      assert.match(res.reason, /matched_assistant_keyword/);
    },
  );

  await t.test("should default conversational greetings to casual mode", () => {
    const res = classifyIntent("Hey Mana, how is it going?");
    assert.strictEqual(res.mode, "casual");
    assert.strictEqual(res.reason, "default_fallback");
  });
});
