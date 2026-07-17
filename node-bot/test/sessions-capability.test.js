const assert = require("node:assert/strict");
const express = require("express");
const test = require("node:test");

const { sessionsCapability } = require("../capabilities/sessions-capability");
const { withServer } = require("./helpers");

function fakeStore(overrides = {}) {
  return {
    listSessions: () => [],
    getSession: () => null,
    renameSession: () => null,
    deleteSession: () => false,
    ...overrides,
  };
}

test("sessions capability lists sessions from the store", async () => {
  const app = express();
  app.use(express.json());
  sessionsCapability.registerRoutes(app, {
    acpMemoryStore: fakeStore({
      listSessions: () => [
        { sessionId: "a", name: "First chat", createdAt: "t1", updatedAt: "t2", turnCount: 2 },
      ],
    }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/sessions`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.sessions.length, 1);
    assert.equal(payload.sessions[0].sessionId, "a");
  });
});

test("sessions capability returns a single session or 404", async () => {
  const app = express();
  app.use(express.json());
  sessionsCapability.registerRoutes(app, {
    acpMemoryStore: fakeStore({
      getSession: (id) => (id === "known" ? { sessionId: "known", turns: [] } : null),
    }),
  });

  await withServer(app, async (baseUrl) => {
    const ok = await fetch(`${baseUrl}/sessions/known`);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).sessionId, "known");

    const missing = await fetch(`${baseUrl}/sessions/unknown`);
    assert.equal(missing.status, 404);
  });
});

test("sessions capability renames a session and validates the body", async () => {
  const app = express();
  app.use(express.json());
  let renameCall = null;
  sessionsCapability.registerRoutes(app, {
    acpMemoryStore: fakeStore({
      renameSession: (id, name) => {
        renameCall = [id, name];
        return id === "known" ? { sessionId: id, name } : null;
      },
    }),
  });

  await withServer(app, async (baseUrl) => {
    const missingName = await fetch(`${baseUrl}/sessions/known`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(missingName.status, 400);

    const ok = await fetch(`${baseUrl}/sessions/known`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New name" }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(renameCall, ["known", "New name"]);

    const notFound = await fetch(`${baseUrl}/sessions/missing`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New name" }),
    });
    assert.equal(notFound.status, 404);
  });
});

test("sessions capability deletes a session and reports 404 when absent", async () => {
  const app = express();
  app.use(express.json());
  sessionsCapability.registerRoutes(app, {
    acpMemoryStore: fakeStore({
      deleteSession: (id) => id === "known",
    }),
  });

  await withServer(app, async (baseUrl) => {
    const ok = await fetch(`${baseUrl}/sessions/known`, { method: "DELETE" });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { deleted: true, sessionId: "known" });

    const missing = await fetch(`${baseUrl}/sessions/nope`, { method: "DELETE" });
    assert.equal(missing.status, 404);
  });
});

test("sessions capability reports health with the current session count", () => {
  const health = sessionsCapability.getHealth({
    acpMemoryStore: fakeStore({ listSessions: () => [{}, {}] }),
  });
  assert.equal(health.status, "configured");
  assert.equal(health.sessionCount, 2);
});
