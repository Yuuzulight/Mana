// #935: the vault sync's status and "Sync now" for Settings.
const assert = require("node:assert/strict");
const express = require("express");
const test = require("node:test");

const { memoryVaultCapability } = require("../capabilities/memory-vault-capability");
const { withServer } = require("./helpers");

function appWith(context) {
  const app = express();
  app.use(express.json());
  memoryVaultCapability.registerRoutes(app, { checkAdminAuth: () => true, ...context });
  return app;
}

test("GET /admin/memory/vault returns the status, or vaultDir null when sync is off", async () => {
  const status = { vaultDir: "D:\\vault", mode: "polling", notes: 3, skipped: [{ file: "Facts/x.md", reason: "empty note" }] };
  await withServer(appWith({ getMemoryVault: () => ({ getStatus: () => status }) }), async (baseUrl) => {
    assert.deepEqual(await (await fetch(`${baseUrl}/admin/memory/vault`)).json(), status);
  });
  await withServer(appWith({ getMemoryVault: () => null }), async (baseUrl) => {
    assert.deepEqual(await (await fetch(`${baseUrl}/admin/memory/vault`)).json(), { vaultDir: null });
    const response = await fetch(`${baseUrl}/admin/memory/vault/sync`, { method: "POST" });
    assert.equal(response.status, 409);
  });
});

test("POST /admin/memory/vault/sync syncs, refreshes the views and returns the new status", async () => {
  const calls = [];
  const vault = {
    sync: () => calls.push("sync"),
    refreshViews: () => calls.push("views"),
    getStatus: () => ({ vaultDir: "D:\\vault", mode: "watching", notes: calls.length }),
  };
  await withServer(appWith({ getMemoryVault: () => vault }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/memory/vault/sync`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ["sync", "views"]);
    assert.equal((await response.json()).notes, 2);
  });
});

test("the vault routes need admin auth", async () => {
  const vault = { sync: () => assert.fail("synced without auth"), getStatus: () => ({}) };
  const app = appWith({
    getMemoryVault: () => vault,
    checkAdminAuth: (req, res) => {
      res.status(401).json({ ok: false });
      return false;
    },
  });
  await withServer(app, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/admin/memory/vault`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/admin/memory/vault/sync`, { method: "POST" })).status, 401);
  });
});
