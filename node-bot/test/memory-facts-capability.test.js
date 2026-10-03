const assert = require("node:assert/strict");
const express = require("express");
const test = require("node:test");

const { memoryFactsCapability } = require("../capabilities/memory-facts-capability");
const { withServer } = require("./helpers");

function fakeStore(overrides = {}) {
  return {
    listFacts: () => [],
    rememberFact: () => ({ ok: true, action: "archive", key: "x", found: true }),
    ...overrides,
  };
}

test("GET /admin/memory/facts returns the store's full fact list", async () => {
  const app = express();
  app.use(express.json());
  memoryFactsCapability.registerRoutes(app, {
    checkAdminAuth: () => true,
    acpMemoryStore: fakeStore({
      listFacts: () => [
        { key: "gpu", text: "RTX 5080", status: "active", unverifiedSource: true },
      ],
    }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/memory/facts`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.facts.length, 1);
    assert.equal(payload.facts[0].unverifiedSource, true);
    // Issue #673: derived trust rides along with each fact.
    assert.equal(payload.facts[0].trust, "untrusted");
  });
});

test("GET /admin/memory/facts is blocked when checkAdminAuth rejects", async () => {
  const app = express();
  app.use(express.json());
  memoryFactsCapability.registerRoutes(app, {
    checkAdminAuth: (req, res) => {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return false;
    },
    acpMemoryStore: fakeStore(),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/memory/facts`);
    assert.equal(response.status, 401);
  });
});

test("POST /admin/memory/facts/:key/archive calls rememberFact with action=archive", async () => {
  const app = express();
  app.use(express.json());
  let capturedArgs = null;
  memoryFactsCapability.registerRoutes(app, {
    checkAdminAuth: () => true,
    acpMemoryStore: fakeStore({
      rememberFact: (args) => {
        capturedArgs = args;
        return { ok: true, action: "archive", key: args.key, found: true };
      },
    }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/memory/facts/gpu/archive`, { method: "POST" });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.found, true);
    assert.equal(capturedArgs.key, "gpu");
    assert.equal(capturedArgs.action, "archive");
    assert.equal(capturedArgs.source, "human");
  });
});

test("POST /admin/memory/facts/:key/pin sets the pinned flag and 404s an unknown key (issue #674)", async () => {
  const app = express();
  app.use(express.json());
  const calls = [];
  memoryFactsCapability.registerRoutes(app, {
    checkAdminAuth: () => true,
    acpMemoryStore: fakeStore({
      setFactPinned: (key, pinned) => {
        calls.push([key, pinned]);
        return { key, found: key === "name", pinned };
      },
    }),
  });

  await withServer(app, async (baseUrl) => {
    const post = (key, body) =>
      fetch(`${baseUrl}/admin/memory/facts/${key}/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.equal((await post("name", { pinned: true })).status, 200);
    // Only a literal true pins -- a truthy string does not.
    assert.equal((await post("name", { pinned: "yes" })).status, 200);
    assert.equal((await post("missing", { pinned: true })).status, 404);
  });
  assert.deepEqual(calls, [["name", true], ["name", false], ["missing", true]]);
});

test("POST /admin/memory/facts/:key/confirm confirms as the human and 404s an unknown key (issue #663)", async () => {
  const app = express();
  app.use(express.json());
  const calls = [];
  memoryFactsCapability.registerRoutes(app, {
    checkAdminAuth: () => true,
    acpMemoryStore: fakeStore({
      rememberFact: (args) => {
        calls.push(args);
        return { ok: true, action: "confirm", key: args.key, found: args.key === "cat" };
      },
    }),
  });

  await withServer(app, async (baseUrl) => {
    const confirmed = await fetch(`${baseUrl}/admin/memory/facts/cat/confirm`, { method: "POST" });
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json()).ok, true);
    const missing = await fetch(`${baseUrl}/admin/memory/facts/dog/confirm`, { method: "POST" });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).ok, false);
    assert.deepEqual(calls[0], { key: "cat", action: "confirm", source: "human" });
  });
});

test("GET /admin/memory/facts/:key/history returns the store's logged changes for that key (issue #673)", async () => {
  const app = express();
  app.use(express.json());
  const entries = [{ at: "2026-09-01T00:00:00.000Z", op: "add", key: "gpu", before: null, after: { text: "RTX 5080" } }];
  memoryFactsCapability.registerRoutes(app, {
    checkAdminAuth: () => true,
    acpMemoryStore: fakeStore({ getFactHistory: (key) => (key === "gpu" ? entries : []) }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/memory/facts/gpu/history`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, key: "gpu", entries });
  });
});

// Issue #641: real store + real graph, so the view's data is what an
// actual instance would serve, not a fake's shape.
test("GET /admin/memory/graph returns typed nodes, weighted edges and every fact window", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { createAcpMemoryStore } = require("../acp-memory-store");
  const { createMemoryGraph } = require("../memory-graph");

  const memoryGraph = createMemoryGraph({ dbPath: ":memory:" });
  let clock = 0;
  const store = createAcpMemoryStore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-memory-graph-view-")),
    memoryGraph,
    now: () => new Date(Date.UTC(2026, 8, 1, 0, 0, clock++)).toISOString(),
  });
  await store.appendTurn({ sessionId: "s1", user: "Alice Smith met Bob Jones at Tokyo Tower.", assistant: "" });
  await store.appendTurn({ sessionId: "s1", user: "Alice Smith and Bob Jones again.", assistant: "" });
  store.setEntityType("alice smith", "person");
  store.setEntityType("tokyo tower", "not_an_entity");
  store.rememberFact({ key: "gpu", text: "RTX 3070 Ti" });
  store.rememberFact({ key: "gpu", text: "RTX 5080", action: "patch" });

  const app = express();
  memoryFactsCapability.registerRoutes(app, { checkAdminAuth: () => true, acpMemoryStore: store });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/memory/graph`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload.nodes, [
      { key: "alice smith", display: "Alice Smith", type: "person" },
      { key: "bob jones", display: "Bob Jones", type: null },
    ]);
    assert.equal(payload.edges.length, 1);
    assert.equal(payload.edges[0].weight, 2);
    assert.deepEqual(
      payload.facts.map((f) => [f.text, Boolean(f.invalidatedAt)]),
      [["RTX 5080", false], ["RTX 3070 Ti", true]],
    );
  });
  memoryGraph.close();
});

// #1331: add / delete from the launcher, against the real store.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAcpMemoryStore } = require("../acp-memory-store");

function realStoreApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-facts-"));
  const store = createAcpMemoryStore({ dataDir: dir });
  const app = express();
  app.use(express.json());
  memoryFactsCapability.registerRoutes(app, { checkAdminAuth: () => true, acpMemoryStore: store });
  return { app, store };
}

const send = (baseUrl, method, url, body) =>
  fetch(`${baseUrl}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

test("POST /admin/memory/facts adds an active fact in the user's words, and rejects blanks and duplicates (#1331)", async () => {
  const { app, store } = realStoreApp();
  await withServer(app, async (baseUrl) => {
    assert.equal((await send(baseUrl, "POST", "/admin/memory/facts", { key: " ", text: "x" })).status, 400);
    assert.equal((await send(baseUrl, "POST", "/admin/memory/facts", { key: "pet", text: " " })).status, 400);
    const added = await send(baseUrl, "POST", "/admin/memory/facts", { key: "pet", text: "I have a cat" });
    assert.equal(added.status, 200);
    const fact = store.listFacts().find((f) => f.key === "pet");
    assert.equal(fact.status, "active");
    assert.equal(fact.text, "I have a cat");
    assert.equal((await send(baseUrl, "POST", "/admin/memory/facts", { key: "PET", text: "dog" })).status, 400);
  });
});

test("DELETE /admin/memory/facts/:key really removes a live or archived fact and hides it from the list (#1331)", async () => {
  const { app, store } = realStoreApp();
  store.rememberFact({ key: "live", text: "one", source: "human", origin: { kind: "user_stated" } });
  store.rememberFact({ key: "old", text: "two", source: "human", origin: { kind: "user_stated" } });
  store.rememberFact({ key: "old", action: "archive", source: "human" });
  await withServer(app, async (baseUrl) => {
    assert.equal((await send(baseUrl, "DELETE", "/admin/memory/facts/live")).status, 200);
    assert.equal((await send(baseUrl, "DELETE", "/admin/memory/facts/old")).status, 200);
    assert.equal((await send(baseUrl, "DELETE", "/admin/memory/facts/missing")).status, 404);
    const listed = await (await fetch(`${baseUrl}/admin/memory/facts`)).json();
    assert.deepEqual(listed.facts, []);
  });
  assert.ok(store.listFacts().every((f) => f.status === "stale"));
});
