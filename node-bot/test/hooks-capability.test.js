const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const test = require("node:test");

const { hooksCapability } = require("../capabilities/hooks-capability");
const { createHooksStore } = require("../hooks-store");
const { withServer } = require("./helpers");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-hooks-cap-"));
}

function buildApp(hooksStore) {
  const app = express();
  app.use(express.json());
  hooksCapability.registerRoutes(app, { hooksStore });
  return app;
}

test("GET /hooks lists persisted rules", async () => {
  const hooksStore = createHooksStore({ dataDir: createTempDir() });
  hooksStore.addRule({ phase: "pre", action: "deny", toolName: "file_write", pathContains: ".env" });

  const app = buildApp(hooksStore);
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/hooks`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.rules.length, 1);
    assert.equal(payload.rules[0].pathContains, ".env");
  });
});

test("POST /hooks creates a rule", async () => {
  const hooksStore = createHooksStore({ dataDir: createTempDir() });
  const app = buildApp(hooksStore);
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/hooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phase: "post", action: "run-command", toolName: "file_write", command: "prettier", args: ["{path}"] }),
    });
    const payload = await response.json();
    assert.equal(response.status, 201);
    assert.equal(payload.command, "prettier");
    assert.equal(hooksStore.listRules().length, 1);
  });
});

test("POST /hooks rejects an invalid action for its phase", async () => {
  const hooksStore = createHooksStore({ dataDir: createTempDir() });
  const app = buildApp(hooksStore);
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/hooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phase: "pre", action: "run-command", toolName: "file_write" }),
    });
    assert.equal(response.status, 400);
  });
});

test("DELETE /hooks/:id removes a rule and 404s for an unknown id", async () => {
  const hooksStore = createHooksStore({ dataDir: createTempDir() });
  const rule = hooksStore.addRule({ phase: "pre", action: "ask", toolName: "file_write", pathContains: "package.json" });
  const app = buildApp(hooksStore);
  await withServer(app, async (baseUrl) => {
    const ok = await fetch(`${baseUrl}/hooks/${rule.id}`, { method: "DELETE" });
    assert.equal(ok.status, 200);
    assert.equal(hooksStore.listRules().length, 0);

    const missing = await fetch(`${baseUrl}/hooks/${rule.id}`, { method: "DELETE" });
    assert.equal(missing.status, 404);
  });
});

test("getHealth reports the current rule count", () => {
  const hooksStore = createHooksStore({ dataDir: createTempDir() });
  const empty = hooksCapability.getHealth({ hooksStore });
  assert.equal(empty.count, 0);
  assert.match(empty.message, /No hook rules configured/);
});
