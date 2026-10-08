// #1426: "Tell Mana what to remember or change": a suggestion first, written only on Save it.
const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createAcpMemoryStore } = require("../acp-memory-store");
const { memoryFactsCapability } = require("../capabilities/memory-facts-capability");
const { cleanChanges, parseAnswer } = require("../memory-ask");
const { withServer } = require("./helpers");

function setup(runLocalReply) {
  const store = createAcpMemoryStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-ask-")) });
  store.rememberFact({ key: "editor", text: "Uses VS Code", source: "human", origin: { kind: "user_stated" }, category: "about-you" });
  store.rememberFact({ key: "raid", text: "Raid is Thursday", source: "human", origin: { kind: "user_stated" }, category: "hobbies" });
  const app = express();
  app.use(express.json());
  memoryFactsCapability.registerRoutes(app, { checkAdminAuth: () => true, acpMemoryStore: store, runLocalReply });
  const send = (baseUrl, url, body) =>
    fetch(`${baseUrl}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const fact = (key) => store.listFacts().find((f) => f.key === key && f.status !== "stale");
  return { store, app, send, fact };
}

test("asking suggests a change and writes nothing; Save it applies it as the user's words", async () => {
  let prompt = "";
  const t = setup(async (p) => {
    prompt = p;
    return '<think>hmm</think>Sure! {"reply": "I\'ll change editor from VS Code to Cursor. Okay?", "changes": [{"action": "change", "key": "Editor", "text": "Uses Cursor", "category": "about-you"}, {"action": "forget", "key": "nope"}]}';
  });
  await withServer(t.app, async (baseUrl) => {
    const asked = await (await t.send(baseUrl, "/admin/memory/ask", { text: "I switched to Cursor" })).json();
    assert.match(prompt, /- editor: Uses VS Code \[about-you\]/);
    assert.match(prompt, /The user says: "I switched to Cursor"/);
    assert.equal(asked.reply, "I'll change editor from VS Code to Cursor. Okay?");
    // Only what can apply: the unknown key is dropped, the key spelled as stored.
    assert.deepEqual(asked.changes, [{ action: "change", key: "editor", text: "Uses Cursor", category: "about-you", was: "Uses VS Code" }]);
    assert.equal(t.fact("editor").text, "Uses VS Code"); // nothing written yet

    const applied = await (await t.send(baseUrl, "/admin/memory/ask/apply", { changes: asked.changes })).json();
    assert.equal(applied.applied, 1);
    assert.equal(t.fact("editor").text, "Uses Cursor");
    assert.equal(t.fact("editor").status, "active");
  });
});

test("adds, archives and forgets; refuses with words when it can't", async () => {
  const replies = [null, "no json here"];
  const t = setup(async () => replies.shift());
  await withServer(t.app, async (baseUrl) => {
    assert.equal((await t.send(baseUrl, "/admin/memory/ask", { text: " " })).status, 400);
    const unloaded = await t.send(baseUrl, "/admin/memory/ask", { text: "forget raid" });
    assert.equal(unloaded.status, 503);
    assert.match((await unloaded.json()).error, /isn't loaded/);
    assert.equal((await t.send(baseUrl, "/admin/memory/ask", { text: "forget raid" })).status, 422);

    await t.send(baseUrl, "/admin/memory/ask/apply", {
      changes: [
        { action: "add", key: "pet", text: "Has a cat", category: "about-you" },
        { action: "archive", key: "raid" },
        { action: "delete-everything", key: "editor" },
      ],
    });
    assert.equal(t.fact("pet").category, "about-you");
    assert.equal(t.fact("raid").status, "archived");
    assert.equal(t.fact("editor").status, "active");
  });
});

test("an add on a key she already has becomes a change; the answer is found inside prose", () => {
  const facts = [{ key: "Editor", text: "VS Code" }];
  assert.deepEqual(cleanChanges([{ action: "add", key: "editor", text: "Cursor" }], facts), [{ action: "change", key: "Editor", text: "Cursor", was: "VS Code" }]);
  assert.deepEqual(cleanChanges([{ action: "change", key: "editor" }], facts), []); // no text
  assert.deepEqual(parseAnswer('Here you go:\n```json\n{"reply":"Okay?","changes":[]}\n```'), { reply: "Okay?", changes: [] });
  assert.equal(parseAnswer("nothing"), null);
});
