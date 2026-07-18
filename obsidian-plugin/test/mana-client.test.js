const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMemoryUrl, fetchManaMemory } = require("../mana-client.js");

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
