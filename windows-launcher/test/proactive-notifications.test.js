const assert = require("node:assert/strict");
const test = require("node:test");

const {
  OPEN_CHAT_ACTION_INDEX,
  isProactiveToast,
  buildToastOptions,
} = require("../proactive-notifications");

test("isProactiveToast accepts dream/cron/research payloads", () => {
  assert.equal(isProactiveToast({ type: "dream" }), true);
  assert.equal(isProactiveToast({ type: "cron" }), true);
  assert.equal(isProactiveToast({ type: "research" }), true);
});

test("isProactiveToast rejects doctor and audit payloads (issue #423)", () => {
  // "doctor" already has its own tooltip/balloon handling in main.js; "audit"
  // is a high-frequency background-memory event that would spam toasts if
  // it were included here.
  assert.equal(isProactiveToast({ type: "doctor" }), false);
  assert.equal(isProactiveToast({ type: "audit" }), false);
  assert.equal(isProactiveToast(null), false);
  assert.equal(isProactiveToast({}), false);
});

test("buildToastOptions maps payload title/text and offers Open Chat / Dismiss actions", () => {
  const options = buildToastOptions({
    type: "dream",
    title: "Dream Mode",
    text: "Consolidated 4 new session summaries.",
  });
  assert.equal(options.title, "Dream Mode");
  assert.equal(options.body, "Consolidated 4 new session summaries.");
  assert.equal(options.actions[OPEN_CHAT_ACTION_INDEX].text, "Open Chat");
  assert.equal(options.actions.length, 2);
});

test("buildToastOptions falls back to a default title when the payload has none", () => {
  const options = buildToastOptions({ type: "cron", text: "Job finished." });
  assert.equal(options.title, "Mana");
});
