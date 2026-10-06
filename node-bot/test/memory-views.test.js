// #1387: which entities get a vault note, and why the others don't.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

process.env.MANA_ACP_MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mana-memory-views-"));

const { visibleEntities, buildFactsIndex, buildPendingReview, buildEntitiesIndex } = require("../memory-views");
const { noteName } = require("../memory-vault");
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

// #1388: the Facts / Pending / Entities index views.
const fact = (key, status, text = "t", extra = {}) => ({ key, status, text, ...extra });
const slugOf = (k) => k.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "untitled";
const bullets = (md) => md.split("\n").filter((l) => l.startsWith("- "));

test("empty vault: each index says there is nothing yet", () => {
  assert.match(buildFactsIndex([]), /Active facts: 0[\s\S]*_\(none yet\)_/);
  assert.match(buildPendingReview([]), /waiting for approval: 0[\s\S]*_\(none\)_/);
  assert.match(buildEntitiesIndex({}, {}, slugOf), /_\(none yet\)_/);
});

test("facts index lists only active facts, sorted, linked to their real note names", () => {
  const facts = [
    fact("zeta", "active"),
    fact("Alpha/beta: #1", "active"),
    fact("old", "archived"),
    fact("superseded", "active", "t", { invalidatedAt: "2026-01-01" }),
    fact("waiting", "pending"),
  ];
  const out = buildFactsIndex(facts);
  assert.deepEqual(bullets(out), [`- [[Facts/${noteName("Alpha/beta: #1")}|Alpha/beta: #1]]`, "- [[Facts/zeta|zeta]]"]);
  assert.match(out, /Active facts: 2/);
  assert.equal(out, buildFactsIndex([...facts].reverse()));
});

test("special characters can't break the wikilink or the filename", () => {
  const [line] = bullets(buildFactsIndex([fact("a|b]] [[c\nd: e?", "active")]));
  const [, target, text] = /^- \[\[([^|]*)\|([^\]]*)\]\]$/.exec(line);
  assert.match(target, /^Facts\/[^/\<>:"|?*[\]#^\n]+$/);
  assert.equal(text, "a b c d: e?");
});

test("pending review links to the pending notes and says a link never approves", () => {
  const out = buildPendingReview([fact("b", "pending", "likes\ntea"), fact("a", "pending", "x"), fact("c", "active")]);
  assert.match(out, /never approves anything/);
  assert.deepEqual(bullets(out), ["- [[Facts/Pending/a|a]]: x", "- [[Facts/Pending/b|b]]: likes tea"]);
});

test("entities index groups by type, keeps untyped under Unclassified, shows aliases", () => {
  const index = { "jane doe": seen("Jane Doe"), jd: seen("JD"), kyoto: seen("Kyoto", 2), "the thing": seen("The Thing", 2), and: seen("And", 5), nope: seen("Nope") };
  const types = {
    "jane doe": { type: "person" },
    jd: { type: "person", canonicalKey: "jane doe" },
    kyoto: { type: "place" },
    nope: { type: "not_an_entity" },
  };
  const out = buildEntitiesIndex(visibleEntities(index, types).entities, types, slugOf);
  assert.match(out, /## People\n\n- \[\[Views\/Entities\/jane-doe\|Jane Doe\]\] \(also: jd\)\n/);
  assert.match(out, /## Places\n\n- \[\[Views\/Entities\/kyoto\|Kyoto\]\]\n/);
  assert.match(out, /## Unclassified\n\n- \[\[Views\/Entities\/the-thing\|The Thing\]\]\n/);
  assert.doesNotMatch(out, /Nope|And|## Objects/);
  assert.ok(out.indexOf("## People") < out.indexOf("## Places") && out.indexOf("## Places") < out.indexOf("## Unclassified"));
});

test("every entity link in the index is a note buildMemoryNotes writes", () => {
  const index = { "jane doe": seen("Jane Doe"), jd: seen("JD"), "c++ & rust!": seen("C++ & Rust!", 2), and: seen("And", 4) };
  const types = { "jane doe": { type: "person" }, jd: { type: "person", canonicalKey: "jane doe" } };
  const written = new Set(buildMemoryNotes(index, [], [], types).map((n) => `Views/Entities/${n.slug}`));
  const out = buildEntitiesIndex(visibleEntities(index, types).entities, types, require("../server").slugifyEntityName);
  const linked = [...out.matchAll(/\[\[([^\]|]+)\|/g)].map((m) => m[1]);
  assert.equal(linked.length, 2);
  for (const l of linked) assert.ok(written.has(l), `dangling link ${l}`);
});
