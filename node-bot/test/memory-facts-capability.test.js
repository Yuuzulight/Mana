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
