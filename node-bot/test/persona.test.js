const assert = require("node:assert/strict");
const test = require("node:test");

const persona = require("../persona");

test("MANA_PERSONA and DEFAULT_SYSTEM_PROMPT are both non-empty and DEFAULT_SYSTEM_PROMPT builds on MANA_PERSONA", () => {
  assert.ok(persona.MANA_PERSONA.length > 0);
  assert.ok(persona.DEFAULT_SYSTEM_PROMPT.startsWith(persona.MANA_PERSONA));
  assert.match(persona.DEFAULT_SYSTEM_PROMPT, /spoken conversation/i);
});

test("buildPersonaPrompt returns just the base persona with no override set", () => {
  assert.equal(persona.buildPersonaPrompt("session-no-override"), persona.MANA_PERSONA);
  assert.equal(persona.buildPersonaPrompt(), persona.MANA_PERSONA);
});

test("setPersonaOverride layers on top of the base persona for that session only", () => {
  persona.setPersonaOverride("session-focused", "Stay strictly on-task, no teasing.");
  const withOverride = persona.buildPersonaPrompt("session-focused");
  assert.match(withOverride, new RegExp(persona.MANA_PERSONA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(withOverride, /Stay strictly on-task/);

  // A different session is unaffected.
  assert.equal(persona.buildPersonaPrompt("session-unaffected"), persona.MANA_PERSONA);

  persona.clearPersonaOverride("session-focused");
});

test("clearPersonaOverride reverts a session cleanly without touching MANA_PERSONA", () => {
  const before = persona.MANA_PERSONA;
  persona.setPersonaOverride("session-quiet", "Keep replies to one sentence.");
  assert.notEqual(persona.buildPersonaPrompt("session-quiet"), before);

  const cleared = persona.clearPersonaOverride("session-quiet");
  assert.equal(cleared, true);
  assert.equal(persona.buildPersonaPrompt("session-quiet"), before);
  assert.equal(persona.MANA_PERSONA, before);
});

test("clearPersonaOverride on a session with no override returns false", () => {
  assert.equal(persona.clearPersonaOverride("session-never-set"), false);
});

test("setPersonaOverride rejects an empty sessionId or override", () => {
  assert.equal(persona.setPersonaOverride("", "text"), false);
  assert.equal(persona.setPersonaOverride("session-x", ""), false);
  assert.equal(persona.setPersonaOverride("session-x", "   "), false);
});

test("getPersonaOverride returns the raw override text, or null", () => {
  assert.equal(persona.getPersonaOverride("session-none"), null);
  persona.setPersonaOverride("session-y", "Be extra shy today.");
  assert.equal(persona.getPersonaOverride("session-y"), "Be extra shy today.");
  persona.clearPersonaOverride("session-y");
});
