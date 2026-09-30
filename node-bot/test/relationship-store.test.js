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
  findForgetRequest,
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
  fs.writeFileSync(filePath, JSON.stringify({ notes: [{ text: "From before ids.", at: "2026-09-30T00:00:00.000Z" }] }));
  const [old] = store.list();
  assert.match(old.id, /^[0-9a-f]{8}$/);
  assert.equal(store.list()[0].id, old.id, "a stable id");
  assert.equal(store.remove(old.id).text, "From before ids.");
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

test("notes can be edited, removed and forgotten; a bare \"forget that\" only takes a fresh one", () => {
  let t = Date.parse("2026-10-01T12:00:00.000Z");
  const store = createRelationshipStore({ now: () => new Date(t).toISOString() });
  const pizza = store.add("We joke about pineapple pizza.");
  const stretch = store.add("I promised to nag them about stretching.");
  assert.match(pizza.id, /^[0-9a-f]{8}$/);
  assert.equal(store.update(pizza.id, "We joke about pineapple on pizza.").text, "We joke about pineapple on pizza.");
  assert.equal(store.update("nope", "x"), null);
  assert.equal(store.update(pizza.id, "  "), null);

  t += 31 * 60 * 1000;
  assert.deepEqual(store.forget(""), [], "too old for \"forget that\"");
  const fresh = store.add("They blush when I say thank you.");
  assert.deepEqual(store.forget("").map((n) => n.id), [fresh.id]);
  assert.deepEqual(store.forget("PINEAPPLE pizza").map((n) => n.id), [pizza.id]);
  assert.deepEqual(store.forget("karaoke"), []);
  assert.equal(store.remove(stretch.id).id, stretch.id);
  assert.equal(store.remove(stretch.id), null);
  assert.deepEqual(store.list(), []);
});

test("forget requests are whole messages of mine", () => {
  assert.deepEqual(findForgetRequest("Forget that."), { query: "" });
  assert.deepEqual(findForgetRequest("please forget that note"), { query: "" });
  assert.deepEqual(findForgetRequest("forget the note about pineapple pizza!"), { query: "pineapple pizza" });
  assert.equal(findForgetRequest("don't forget that I have a raid"), null);
  assert.equal(findForgetRequest("forget that I like tea"), null, "a memory fact, not a note");
});

test("Settings routes list, edit and remove each character's notes; chat forgets the active one's", async () => {
  const express = require("express");
  const { withServer } = require("./helpers");
  const { createRelationshipCapability } = require("../capabilities/relationship-capability");
  const characters = createCharacterStore({ filePath: path.join(os.tmpdir(), "no-such-characters.json") });
  const stores = new Map();
  const storeFor = (id) => stores.get(id) || stores.set(id, createRelationshipStore()).get(id);
  const evilNote = storeFor("evil-mana").add("They think I'm the funnier sister.");
  const capability = createRelationshipCapability(characters, storeFor);
  const app = express();
  app.use(express.json());
  capability.registerRoutes(app);
  await withServer(app, async (baseUrl) => {
    const call = (method, route, body) =>
      fetch(`${baseUrl}${route}`, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
    const listed = await (await call("GET", "/characters/relationships")).json();
    assert.deepEqual(listed.characters.map((c) => [c.id, c.name, c.notes.length]), [["mana", "Mana", 0], ["evil-mana", "Evil Mana", 1]]);
    const route = `/characters/evil-mana/relationship/notes/${evilNote.id}`;
    assert.equal((await call("PUT", route, {})).status, 400);
    assert.equal((await call("PUT", "/characters/nobody/relationship/notes/x", { text: "x" })).status, 404);
    assert.equal((await (await call("PUT", route, { text: "They say I'm funnier." })).json()).note.text, "They say I'm funnier.");
    assert.equal((await call("DELETE", route)).status, 200);
    assert.equal((await call("DELETE", route)).status, 404);
  });

  storeFor("mana").add("They call me their little gremlin.");
  assert.deepEqual(capability.onUserInput({ text: "forget that" }), { reply: 'Okay, I forgot: "They call me their little gremlin."' });
  assert.equal(capability.onUserInput({ text: "forget that" }), null, "nothing fresh: the reply handles it");
  assert.deepEqual(capability.onUserInput({ text: "forget the note about karaoke" }), { reply: "I don't have a note or milestone about that." });
  assert.equal(capability.onUserInput({ text: "hello" }), null);
});

test("a new note is a chat line on the reply stream", async () => {
  const { createApp } = require("../server");
  const app = createApp({
    llamaServerRuntime: { isEnabled: () => true },
    runToolAwareReply: async (prompt, policy) => {
      await policy.executeTool("relationship__note", { note: "They like my smug face." });
      return { content: "Heh.", toolCalls: [], rounds: 1 };
    },
  });
  const { withServer, useTestAdminToken } = require("./helpers");
  const fetch = useTestAdminToken();
  await withServer(app, async (baseUrl) => {
    const body = await (
      await fetch(`${baseUrl}/reply/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "you look smug", sessionId: "sess-noted", assistantMode: "casual" }),
      })
    ).text();
    const noted = body.trim().split("\n").map((line) => JSON.parse(line)).find((e) => e.type === "noted");
    assert.deepEqual({ ...noted, id: typeof noted.id }, {
      type: "noted",
      kind: "note",
      id: "string",
      text: "They like my smug face.",
      character: "mana",
      characterName: "Mana",
    });
  });
});

test("milestones: dated, the first chat once, edited, removed, forgotten", () => {
  let t = new Date(2026, 9, 1, 12, 0).getTime();
  const store = createRelationshipStore({ now: () => new Date(t).toISOString() });
  assert.equal(store.ensureFirstChat(() => new Date(2025, 5, 3, 20, 0).toISOString()).date, "2025-06-03");
  assert.equal(store.ensureFirstChat(() => null), null, "only once");
  const raid = store.addMilestone("We cleared the raid after 40 wipes.", "2026-02-30");
  assert.equal(raid.date, "2026-10-01", "not a real date: today");
  assert.equal(store.addMilestone("we cleared the raid after 40 wipes.").id, raid.id, "not twice");
  assert.equal(store.updateMilestone(raid.id, { date: "2026-09-12" }).date, "2026-09-12");
  assert.equal(store.updateMilestone(raid.id, { date: "2026-13-01" }), null);
  assert.equal(store.updateMilestone("nope", { text: "x" }), null);
  assert.deepEqual(store.forget("raid wipes").map((m) => m.id), [raid.id]);
  const party = store.addMilestone("Their birthday party.", "2026-05-30");
  assert.deepEqual(store.forget("").map((m) => m.id), [party.id], "forget that: the one just made");
  assert.deepEqual(store.milestones().map((m) => m.text), ["The first time we talked"]);
  assert.equal(store.removeMilestone(store.milestones()[0].id).first, true);
});

test("a milestone comes up now and then, and on its anniversary, never on coding turns", () => {
  let day = new Date(2026, 5, 1, 12, 0);
  const store = createRelationshipStore({ now: () => day.toISOString() });
  const at = (y, m, d) => (day = new Date(y, m - 1, d, 12, 0));
  store.addMilestone("The first time we talked", "2025-06-03");
  store.addMilestone("We named the cat Mochi.", "2026-01-10");
  assert.equal(store.milestoneToMention("coding"), null);
  assert.match(store.milestoneToMention("casual"), /first time we talked \(2025-06-03\)\. Bring it up only if it fits/);
  assert.equal(store.milestoneToMention("casual"), null, "once a day");
  at(2026, 6, 2);
  assert.equal(store.milestoneToMention("casual"), null, "not again for a few days");
  at(2026, 6, 3);
  assert.match(store.milestoneToMention("casual"), /^Today is 1 year since a moment you remember with the user: The first time we talked/);
  at(2026, 6, 6);
  assert.match(store.milestoneToMention("casual"), /named the cat Mochi/, "the least recently brought up");
});

test("the milestone tool shows its chat line too", async () => {
  const store = createRelationshipStore();
  const noted = [];
  const tools = createRelationshipToolSource({ store, onNoted: (item) => noted.push(item) });
  const result = JSON.parse(await tools.executeTool("relationship__milestone", { text: "Our first duet.", date: "2026-09-20" }));
  assert.deepEqual(result, { ok: true, milestone: "Our first duet.", date: "2026-09-20" });
  assert.deepEqual(noted.map((n) => [n.kind, n.text, n.date]), [["milestone", "Our first duet.", "2026-09-20"]]);
  await assert.rejects(tools.executeTool("relationship__milestone", {}), /text is required/);
});

test("Settings routes edit and remove milestones", async () => {
  const express = require("express");
  const { withServer } = require("./helpers");
  const { createRelationshipCapability } = require("../capabilities/relationship-capability");
  const characters = createCharacterStore({ filePath: path.join(os.tmpdir(), "no-such-characters.json") });
  const store = createRelationshipStore();
  const duet = store.addMilestone("Our first duet.", "2026-09-20");
  const app = express();
  app.use(express.json());
  createRelationshipCapability(characters, () => store).registerRoutes(app);
  await withServer(app, async (baseUrl) => {
    const call = (method, route, body) =>
      fetch(`${baseUrl}${route}`, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
    const route = `/characters/mana/relationship/milestones/${duet.id}`;
    assert.equal((await (await call("GET", "/characters/relationships")).json()).characters[0].milestones[0].id, duet.id);
    assert.equal((await call("PUT", route, {})).status, 400);
    assert.equal((await call("PUT", route, { date: "20/09/2026" })).status, 400);
    assert.equal((await (await call("PUT", route, { text: "Our first duet!", date: "2026-09-21" })).json()).milestone.date, "2026-09-21");
    assert.equal((await call("DELETE", route)).status, 200);
    assert.equal((await call("DELETE", route)).status, 404);
  });
});
