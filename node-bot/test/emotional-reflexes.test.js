const assert = require("node:assert/strict");
const test = require("node:test");

const { checkEmotionalReflexes } = require("../server");

// Issue #295 (piece 2 of #285): the fake store below never touches the
// real acp-memory-store.js data directory -- checkEmotionalReflexes takes
// an injectable store the same way this file's other deps-overridable
// helpers do.
function fakeStore({ lastUpdatedAt } = {}) {
  const rememberFactCalls = [];
  return {
    listSessions: () => (lastUpdatedAt ? [{ sessionId: "s1", updatedAt: lastUpdatedAt }] : []),
    rememberFact: async (args) => {
      rememberFactCalls.push(args);
      return { ok: true };
    },
    rememberFactCalls,
  };
}

test("checkEmotionalReflexes does nothing when no session has ever been recorded", async () => {
  const store = fakeStore();
  await checkEmotionalReflexes(store);
  assert.equal(store.rememberFactCalls.length, 0);
});

test("checkEmotionalReflexes does nothing when the gap since the last session is under the threshold", async () => {
  const store = fakeStore({ lastUpdatedAt: new Date(Date.now() - 3600000).toISOString() }); // 1h ago
  await checkEmotionalReflexes(store);
  assert.equal(store.rememberFactCalls.length, 0);
});

test("checkEmotionalReflexes patches a journal-loneliness fact once the gap crosses the threshold", async () => {
  const store = fakeStore({ lastUpdatedAt: new Date(Date.now() - 50 * 3600000).toISOString() }); // 50h ago, default threshold is 48h
  await checkEmotionalReflexes(store);
  assert.equal(store.rememberFactCalls.length, 1);
  assert.equal(store.rememberFactCalls[0].key, "journal-loneliness");
  assert.equal(store.rememberFactCalls[0].action, "patch");
  assert.match(store.rememberFactCalls[0].text, /50 hours/);
});

test("checkEmotionalReflexes patches the same fact again on a later tick instead of erroring or duplicating", async () => {
  const store = fakeStore({ lastUpdatedAt: new Date(Date.now() - 72 * 3600000).toISOString() }); // 72h ago
  await checkEmotionalReflexes(store);
  await checkEmotionalReflexes(store);
  assert.equal(store.rememberFactCalls.length, 2);
  assert.ok(store.rememberFactCalls.every((c) => c.action === "patch" && c.key === "journal-loneliness"));
});
