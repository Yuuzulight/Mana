const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("../../../node-bot/node_modules/express");
const test = require("node:test");

const cronPlugin = require("../index");
const { withServer } = require("./helpers");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-cron-routes-"));
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

function buildApp(deps) {
  cronPlugin._resetForTests();
  const app = express();
  app.use(express.json());
  cronPlugin.registerRoutes(app, { dataDir: createTempDir(), ...deps });
  return app;
}

test("POST /cron/jobs creates a job, GET /cron/jobs lists it, DELETE removes it", async () => {
  const app = buildApp({});
  await withServer(app, async (baseUrl) => {
    const create = await postJson(`${baseUrl}/cron/jobs`, {
      name: "Daily check",
      jobType: "script",
      actionName: "noop",
      schedule: { type: "daily", hour: 9, minute: 0 },
    });
    assert.equal(create.response.status, 201);
    const id = create.payload.id;

    const list = await fetch(`${baseUrl}/cron/jobs`);
    const listPayload = await list.json();
    assert.ok(listPayload.jobs.some((j) => j.id === id));

    const del = await fetch(`${baseUrl}/cron/jobs/${id}`, { method: "DELETE" });
    assert.equal(del.status, 200);

    const listAfter = await fetch(`${baseUrl}/cron/jobs`);
    const listAfterPayload = await listAfter.json();
    assert.ok(!listAfterPayload.jobs.some((j) => j.id === id));
  });
});

test("POST /cron/jobs surfaces validation errors as 400s", async () => {
  const app = buildApp({});
  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/cron/jobs`, {
      jobType: "script",
      schedule: { type: "interval", everyMs: 1000 },
    });
    assert.equal(response.status, 400);
    assert.match(payload.error, /actionName is required/);
  });
});

test("DELETE /cron/jobs/:id reports 404 for an unknown job", async () => {
  const app = buildApp({});
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/cron/jobs/does-not-exist`, { method: "DELETE" });
    assert.equal(response.status, 404);
  });
});

test("POST /cron/jobs accepts an agent job (prompt required instead of actionName)", async () => {
  const app = buildApp({});
  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/cron/jobs`, {
      name: "Daily summary",
      jobType: "agent",
      prompt: "Summarize today's FFXIV market",
      sessionId: "test-session",
      schedule: { type: "daily", hour: 9, minute: 0 },
    });
    assert.equal(response.status, 201);
    assert.equal(payload.jobType, "agent");
    assert.equal(payload.prompt, "Summarize today's FFXIV market");
  });
});

test("plugin metadata matches the shape other Mana plugins use", () => {
  assert.equal(cronPlugin.key, "cronScheduler");
  assert.equal(cronPlugin.category, "Automation");
  assert.equal(cronPlugin.defaultEnabled, false);
  assert.equal(typeof cronPlugin.registerRoutes, "function");
  const health = cronPlugin.getHealth({ dataDir: createTempDir() });
  assert.equal(health.status, "available");
});
