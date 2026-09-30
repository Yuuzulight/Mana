// Issue #914: each character's own notes on her relationship with the user.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

process.env.MANA_ACP_MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mana-relationship-"));

const {
  MAX_NOTES,
  createRelationshipStore,
  createRelationshipToolSource,
  relationshipPromptBlock,
} = require("../relationship-store");
const { characterFilePath, createCharacterStore, perCharacter } = require("../characters");

test("notes persist, repeat notes move to the newest, and only the newest are kept", () => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mana-rel-")), "relationship.json");
  const store = createRelationshipStore({ filePath, now: () => "2026-09-30T00:00:00.000Z" });
  assert.equal(store.add("   "), null);
  store.add("They  love being called a gremlin.");
  store.add("I promised to remind them about stretching.");
  store.add("they love being called a gremlin.");
  assert.deepEqual(
    createRelationshipStore({ filePath }).list().map((n) => n.text),
    ["I promised to remind them about stretching.", "they love being called a gremlin."],
  );
  for (let i = 0; i < MAX_NOTES + 3; i++) store.add(`note ${i}`);
  const notes = store.list();
  assert.equal(notes.length, MAX_NOTES);
  assert.equal(notes.at(-1).text, `note ${MAX_NOTES + 2}`);
  fs.writeFileSync(filePath, "{ broken");
  assert.deepEqual(store.list(), []);
});

test("each character keeps her own notes", () => {
  const characters = createCharacterStore({ filePath: path.join(os.tmpdir(), "no-such-characters.json") });
  const store = perCharacter(characters, () => createRelationshipStore(), ["list", "add"]);
  store.add("We have a running joke about pineapple pizza.");
  characters.setActive("evil-mana");
  assert.deepEqual(store.list(), [], "Evil Mana doesn't share Mana's notes");
  store.add("They think I'm the funnier sister.");
  characters.setActive("mana");
  assert.deepEqual(store.list().map((n) => n.text), ["We have a running joke about pineapple pizza."]);
  assert.equal(characterFilePath("/d/relationship.json", "evil-mana"), "/d/relationship.evil-mana.json");
});

test("the prompt block and the tool", async () => {
  assert.equal(relationshipPromptBlock([], "casual"), null);
  assert.equal(relationshipPromptBlock([{ text: "x" }], "coding"), null, "not on coding turns");
  assert.match(relationshipPromptBlock([{ text: "They like my teasing." }], "casual"), /other characters don't share these\):\n- They like my teasing\.$/);

  const store = createRelationshipStore();
  const tools = createRelationshipToolSource({ store });
  assert.equal(tools.isKnownToolName("relationship__note"), true);
  assert.deepEqual(JSON.parse(await tools.executeTool("relationship__note", { note: "They like my teasing." })), {
    ok: true,
    note: "They like my teasing.",
  });
  await assert.rejects(tools.executeTool("relationship__note", {}), /note is required/);
});

test("her notes reach her reply's prompt, and the tool is offered in chat", async () => {
  const { createApp } = require("../server");
  const calls = [];
  const app = createApp({
    llamaServerRuntime: { isEnabled: () => true },
    runToolAwareReply: async (prompt, policy, opts) => {
      calls.push({ tools: policy.tools.map((t) => t.function?.name), late: JSON.stringify(opts.extraMessages) });
      if (calls.length === 1) await policy.executeTool("relationship__note", { note: "They call me their little gremlin." });
      return { content: "ok", toolCalls: [], rounds: 1 };
    },
  });
  await app.locals.buildAssistantReply("hi", "", "", "default", "sess-rel", "casual", null, {});
  await app.locals.buildAssistantReply("hi again", "", "", "default", "sess-rel", "casual", null, {});
  assert.ok(calls[0].tools.includes("relationship__note"));
  assert.doesNotMatch(calls[0].late, /little gremlin/);
  assert.match(calls[1].late, /They call me their little gremlin\./);
});
