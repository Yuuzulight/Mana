const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMemoryUrl, buildMemoryNotesUrl, fetchManaMemory, fetchManaMemoryNotes } = require("../mana-client.js");

test("buildMemoryUrl strips trailing slashes", () => {
  assert.equal(buildMemoryUrl("http://localhost:5005/"), "http://localhost:5005/api/memory");
  assert.equal(buildMemoryUrl("http://localhost:5005"), "http://localhost:5005/api/memory");
});

test("fetchManaMemory sends Bearer auth and returns markdown body", async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, text: async () => "# Mana Memory\n" };
  };
  const body = await fetchManaMemory("http://localhost:5005", "secret-key", fakeFetch);
  assert.equal(body, "# Mana Memory\n");
  assert.equal(calls[0].url, "http://localhost:5005/api/memory");
  assert.equal(calls[0].opts.headers.Authorization, "Bearer secret-key");
});

test("fetchManaMemory throws a clear error on invalid key", async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, statusText: "Unauthorized" });
  await assert.rejects(
    () => fetchManaMemory("http://localhost:5005", "bad-key", fakeFetch),
    /rejected the API key/
  );
});

test("fetchManaMemory throws on other non-ok responses", async () => {
  const fakeFetch = async () => ({ ok: false, status: 500, statusText: "Internal Server Error" });
  await assert.rejects(
    () => fetchManaMemory("http://localhost:5005", "key", fakeFetch),
    /500/
  );
});

test("buildMemoryNotesUrl strips trailing slashes", () => {
  assert.equal(buildMemoryNotesUrl("http://localhost:5005/"), "http://localhost:5005/api/memory/notes");
  assert.equal(buildMemoryNotesUrl("http://localhost:5005"), "http://localhost:5005/api/memory/notes");
});

test("fetchManaMemoryNotes sends Bearer auth and returns parsed notes", async () => {
  const calls = [];
  const notes = [{ slug: "acme-corp", title: "Acme Corp", body: "# Acme Corp\n", links: [] }];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => notes };
  };
  const result = await fetchManaMemoryNotes("http://localhost:5005", "secret-key", fakeFetch);
  assert.deepEqual(result, notes);
  assert.equal(calls[0].url, "http://localhost:5005/api/memory/notes");
  assert.equal(calls[0].opts.headers.Authorization, "Bearer secret-key");
});

test("fetchManaMemoryNotes throws a clear error on invalid key", async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, statusText: "Unauthorized" });
  await assert.rejects(
    () => fetchManaMemoryNotes("http://localhost:5005", "bad-key", fakeFetch),
    /rejected the API key/
  );
});

// Issue #935: Mana syncs facts into the vault herself now.
const { isManaOwnedPath, withoutKeyFacts, withoutFactNotes } = require("../mana-client.js");

test("isManaOwnedPath flags Facts/, Views/ and Journal/ only", () => {
  for (const p of ["Facts", "facts/x.md", "/Views/Mood.md", "./Views","Journal\\2026-09-30.md"]) {
    assert.equal(isManaOwnedPath(p), true, p);
  }
  for (const p of ["Mana Memory.md", "Mana", "Notes/Facts", "Factsheet.md"]) {
    assert.equal(isManaOwnedPath(p), false, p);
  }
});

test("withoutKeyFacts drops only the Key Facts section", () => {
  const md = "# Mana Memory\n\n## Summary\n\nHi.\n\n## Key Facts\n\n- a\n- b\n\n## Connections\n\n- c\n";
  assert.equal(withoutKeyFacts(md), "# Mana Memory\n\n## Summary\n\nHi.\n\n## Connections\n\n- c\n");
  assert.equal(withoutKeyFacts("# M\n\n## Summary\n\nHi.\n\n## Key Facts\n\n- a\n"), "# M\n\n## Summary\n\nHi.\n");
});

test("withoutFactNotes drops the Key Facts note", () => {
  const notes = [{ slug: "tokyo" }, { slug: "key-facts" }, { slug: "connections" }];
  assert.deepEqual(withoutFactNotes(notes).map((n) => n.slug), ["tokyo", "connections"]);
});
