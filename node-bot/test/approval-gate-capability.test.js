const assert = require("node:assert/strict");
const express = require("express");
const test = require("node:test");

const { approvalGateCapability } = require("../capabilities/approval-gate-capability");
const { createApprovalGate } = require("../approval-gate");
const { withServer } = require("./helpers");

function createTempDir() {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-approval-gate-cap-"));
}

function buildApp(approvalGate) {
  const app = express();
  app.use(express.json());
  approvalGateCapability.registerRoutes(app, { approvalGate });
  return app;
}

test("GET /approvals/pending lists what's actually pending", async () => {
  const gate = createApprovalGate({ dataDir: createTempDir() });
  gate.registerExecutor("skill-write", () => "created");
  await gate.requestApproval("skill-write", { summary: "Create skill X", payload: {} });

  const app = buildApp(gate);
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/approvals/pending`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.pending.length, 1);
    assert.equal(payload.pending[0].summary, "Create skill X");
  });
});

test("POST /approvals/:id/decide runs the executor and returns its result on allow-once", async () => {
  const gate = createApprovalGate({ dataDir: createTempDir() });
  gate.registerExecutor("skill-write", () => "created");
  const outcome = await gate.requestApproval("skill-write", { payload: {} });

  const app = buildApp(gate);
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/approvals/${outcome.requestId}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow-once" }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.status, "approved");
    assert.equal(payload.result, "created");
  });
});

test("POST /approvals/:id/decide rejects an invalid decision value", async () => {
  const gate = createApprovalGate({ dataDir: createTempDir() });
  gate.registerExecutor("skill-write", () => "created");
  const outcome = await gate.requestApproval("skill-write", { payload: {} });

  const app = buildApp(gate);
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/approvals/${outcome.requestId}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "maybe-later" }),
    });
    assert.equal(response.status, 400);
  });
});

test("POST /approvals/:id/decide returns 404 for an unknown request id", async () => {
  const gate = createApprovalGate({ dataDir: createTempDir() });
  const app = buildApp(gate);
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/approvals/does-not-exist/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "deny" }),
    });
    assert.equal(response.status, 404);
  });
});

test("GET /approvals/guardian-audit lists guardian-cleared entries", async () => {
  const gate = createApprovalGate({
    dataDir: createTempDir(),
    guardianEnabled: true,
    guardianPreCheck: async () => ({ safe: true }),
  });
  gate.registerExecutor("skill-write", () => "created");
  await gate.requestApproval("skill-write", { summary: "trivial change", payload: {} });

  const app = buildApp(gate);
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/approvals/guardian-audit`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.entries.length, 1);
    assert.equal(payload.entries[0].name, "skill-write");
    assert.equal(payload.entries[0].guardianCleared, true);
  });
});

test("getHealth reports the current pending count", () => {
  const gate = createApprovalGate({ dataDir: createTempDir() });
  const empty = approvalGateCapability.getHealth({ approvalGate: gate });
  assert.equal(empty.count, 0);
  assert.match(empty.message, /No approvals pending/);
});
