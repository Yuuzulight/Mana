const test = require("node:test");
const assert = require("node:assert/strict");
const { skillReviewFlags } = require("../renderer/skill-approval");

test("#850: a clean scan with no Guardian verdict is clean", () => {
  assert.deepEqual(skillReviewFlags({ status: "pending", requestId: "r1", flags: [] }), []);
});

test("#850: a Guardian 'not safe' verdict counts as flagged even with empty scan flags", () => {
  assert.deepEqual(skillReviewFlags({ flags: [], guardian: { safe: false, reason: "" } }), ["Guardian judged it risky"]);
  assert.deepEqual(skillReviewFlags({ flags: ["shell-exec"], guardian: { safe: false, reason: "deletes files" } }), [
    "shell-exec",
    "Guardian judged it risky (deletes files)",
  ]);
});
