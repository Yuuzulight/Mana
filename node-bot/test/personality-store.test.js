const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createPersonalityStore, MAX_HISTORY } = require("../personality-store");
const persona = require("../persona");

function createTempFilePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mana-personality-")), "personality.json");
}

test("an unwritten store reports no adjustment rather than failing", () => {
  const store = createPersonalityStore({ filePath: createTempFilePath() });
  assert.deepEqual(store.get(), { traits: "", updatedAt: null, reason: null, history: [] });
});

test("a set personality survives a new store instance (issue #357)", () => {
  const filePath = createTempFilePath();
  createPersonalityStore({ filePath }).set("casual conversational tone", {
    reason: "be more chill",
  });

  // The whole point: an adjustment outlives the process it was made in.
  const reopened = createPersonalityStore({ filePath });
  assert.equal(reopened.get().traits, "casual conversational tone");
  assert.equal(reopened.get().reason, "be more chill");
});

test("each change pushes the prior value onto history (issue #357)", () => {
  const store = createPersonalityStore({ filePath: createTempFilePath() });
  store.set("formal and concise");
  store.set("casual conversational tone", { reason: "be more chill" });

  const state = store.get();
  assert.equal(state.traits, "casual conversational tone");
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].traits, "formal and concise");
});

test("revert steps back to the previous personality (issue #357)", () => {
  const store = createPersonalityStore({ filePath: createTempFilePath() });
  store.set("formal and concise");
  store.set("extremely casual", { reason: "be more chill" });

  // Overshooting an adjustment has to be one action to undo.
  const reverted = store.revert();
  assert.equal(reverted.traits, "formal and concise");
  assert.equal(reverted.history.length, 0);
});

test("revert on a store with no history is a no-op, not a throw (issue #357)", () => {
  const store = createPersonalityStore({ filePath: createTempFilePath() });
  assert.equal(store.revert().traits, "");
  store.set("formal and concise");
  assert.equal(store.revert().traits, "formal and concise");
});

test("clear returns to the core alone but stays reversible (issue #357)", () => {
  const store = createPersonalityStore({ filePath: createTempFilePath() });
  store.set("extremely casual");
  assert.equal(store.clear().traits, "");
  assert.equal(store.revert().traits, "extremely casual");
});

test("history is bounded (issue #357)", () => {
  const store = createPersonalityStore({ filePath: createTempFilePath() });
  for (let i = 0; i < MAX_HISTORY + 5; i++) store.set(`variation ${i}`);
  assert.equal(store.get().history.length, MAX_HISTORY);
});

test("empty traits are rejected rather than silently erasing the personality", () => {
  const store = createPersonalityStore({ filePath: createTempFilePath() });
  store.set("formal and concise");
  assert.throws(() => store.set("   "), /traits is required/);
  assert.equal(store.get().traits, "formal and concise");
});

test("buildPersonaPrompt layers core, personality, then session override (issue #357)", () => {
  persona.setPersonaOverride("s1", "OVERRIDE-LAYER");
  const prompt = persona.buildPersonaPrompt("s1", "PERSONALITY-LAYER");

  // The core always frames what follows, and neither later layer replaces it.
  assert.ok(prompt.startsWith(persona.MANA_PERSONA));
  assert.ok(prompt.indexOf("PERSONALITY-LAYER") < prompt.indexOf("OVERRIDE-LAYER"));
  persona.clearPersonaOverride("s1");
});

test("buildPersonaPrompt is unchanged when called with one argument (issue #357)", () => {
  assert.equal(persona.buildPersonaPrompt("s-none"), persona.MANA_PERSONA);
});
