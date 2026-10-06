// #1387: which entities get a vault note, and why the others don't.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

process.env.MANA_ACP_MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mana-memory-views-"));

const { visibleEntities } = require("../memory-views");
const { buildMemoryNotes } = require("../server");

const seen = (display, n = 1, sessionId = "s1") => Array.from({ length: n }, (_, i) => ({ display, sessionId, at: `2026-10-0${i + 1}` }));

test("filler words, not-an-entity and one-off untyped words get no note, each with a reason", () => {
  const { entities, excluded } = visibleEntities(
    { and: seen("And", 9), because: seen("Because", 3), blorp: seen("Blorp", 4), kyoto: seen("Kyoto"), "jane doe": seen("Jane Doe") },
    { blorp: { type: "not_an_entity" } },
  );
  assert.deepEqual(Object.keys(entities), ["jane doe"]);
  assert.deepEqual(Object.fromEntries(excluded.map((e) => [e.key, e.why])), {
    and: "untyped filler word",
    because: "untyped filler word",
    blorp: "classified as not an entity",
    kyoto: "untyped single word mentioned 1 time",
  });
});

test("a typed entity named like a filler word stays; non-English names aren't filler", () => {
  const { entities } = visibleEntities(
    { well: seen("Well"), "東京": seen("東京", 2), aber: seen("Aber", 2), "café lumière": seen("Café Lumière") },
    { well: { type: "project" } },
  );
  assert.deepEqual(Object.keys(entities).sort(), ["aber", "café lumière", "well", "東京"].sort());
});

test("aliases fold into their canonical entity, which keeps its own name", () => {
  const { entities, excluded } = visibleEntities(
    { "yuuzu": seen("Yuuzu", 2, "s1"), "oneesan": seen("Oneesan", 3, "s2") },
    { yuuzu: { type: "person" }, oneesan: { type: "person", canonicalKey: "yuuzu" } },
  );
  assert.deepEqual(Object.keys(entities), ["yuuzu"]);
  assert.equal(entities.yuuzu.display, "Yuuzu");
  assert.equal(entities.yuuzu.mentions.length, 5);
  assert.deepEqual(excluded, [{ key: "oneesan", why: "alias of yuuzu" }]);
});

test("notes link only to notes that exist, and facts link through aliases", () => {
  const notes = buildMemoryNotes(
    { "acme corp": seen("Acme Corp"), and: seen("And", 5), oneesan: seen("Oneesan"), yuuzu: seen("Yuuzu") },
    ["Oneesan works at Acme Corp"],
    [],
    { yuuzu: { type: "person" }, oneesan: { type: "person", canonicalKey: "yuuzu" } },
  );
  const slugs = new Set(notes.map((n) => n.slug));
  assert.ok(!slugs.has("and") && !slugs.has("oneesan"));
  for (const n of notes) for (const link of n.links) assert.ok(slugs.has(link), `${n.slug} links to missing ${link}`);
  const acme = notes.find((n) => n.slug === "acme-corp");
  assert.deepEqual(acme.links, ["yuuzu"]);
  const facts = notes.find((n) => n.slug === "key-facts");
  assert.match(facts.body, /Oneesan works at Acme Corp \(\[\[acme-corp\]\], \[\[yuuzu\]\]\)/);
  assert.doesNotMatch(facts.body, /\[\[and\]\]/);
});
