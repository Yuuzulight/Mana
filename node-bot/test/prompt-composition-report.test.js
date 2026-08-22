const assert = require("node:assert/strict");
const test = require("node:test");

const {
  recordPromptComposition,
  getPromptComposition,
  getMostRecentComposition,
  resetPromptCompositionReport,
} = require("../prompt-composition-report");

test("recordPromptComposition computes per-block chars/estTokens and totals", () => {
  resetPromptCompositionReport();
  const record = recordPromptComposition("sess-1", [
    { name: "system-prompt", chars: 400, dropped: null },
    { name: "prompt-memory", chars: 100, dropped: { truncated: true } },
  ]);
  assert.equal(record.blocks[0].estTokens, 100);
  assert.equal(record.blocks[1].estTokens, 25);
  assert.equal(record.totalChars, 500);
  assert.equal(record.totalEstTokens, 125);
  assert.equal(record.blocks[1].dropped.truncated, true);
});

test("getPromptComposition returns the latest recorded composition for a session, replacing the prior one", () => {
  resetPromptCompositionReport();
  recordPromptComposition("sess-1", [{ name: "system-prompt", chars: 100 }]);
  recordPromptComposition("sess-1", [{ name: "system-prompt", chars: 200 }]);
  const composition = getPromptComposition("sess-1");
  assert.equal(composition.blocks.length, 1);
  assert.equal(composition.totalChars, 200);
});

test("getPromptComposition returns null for a session nothing was recorded for", () => {
  resetPromptCompositionReport();
  assert.equal(getPromptComposition("no-such-session"), null);
});

test("sessions don't see each other's compositions", () => {
  resetPromptCompositionReport();
  recordPromptComposition("sess-a", [{ name: "system-prompt", chars: 100 }]);
  recordPromptComposition("sess-b", [{ name: "system-prompt", chars: 200 }]);
  assert.equal(getPromptComposition("sess-a").totalChars, 100);
  assert.equal(getPromptComposition("sess-b").totalChars, 200);
});

test("getMostRecentComposition returns the freshest record across all sessions", async () => {
  resetPromptCompositionReport();
  recordPromptComposition("sess-a", [{ name: "system-prompt", chars: 100 }]);
  // Force a distinguishable later timestamp than sess-a's.
  await new Promise((resolve) => setTimeout(resolve, 5));
  recordPromptComposition("sess-b", [{ name: "system-prompt", chars: 200 }]);
  const latest = getMostRecentComposition();
  assert.equal(latest.totalChars, 200);
});

test("getMostRecentComposition returns null when nothing has been recorded", () => {
  resetPromptCompositionReport();
  assert.equal(getMostRecentComposition(), null);
});

test("resetPromptCompositionReport with no argument clears every session", () => {
  recordPromptComposition("sess-a", [{ name: "system-prompt", chars: 100 }]);
  resetPromptCompositionReport();
  assert.equal(getPromptComposition("sess-a"), null);
});

test("resetPromptCompositionReport with a sessionId clears only that session", () => {
  resetPromptCompositionReport();
  recordPromptComposition("sess-a", [{ name: "system-prompt", chars: 100 }]);
  recordPromptComposition("sess-b", [{ name: "system-prompt", chars: 200 }]);
  resetPromptCompositionReport("sess-a");
  assert.equal(getPromptComposition("sess-a"), null);
  assert.equal(getPromptComposition("sess-b").totalChars, 200);
});
