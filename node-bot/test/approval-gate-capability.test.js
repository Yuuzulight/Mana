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

function buildApp(approvalGate, extra = {}) {
  const app = express();
  app.use(express.json());
  approvalGateCapability.registerRoutes(app, { approvalGate, ...extra });
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

test("#669 POST /approvals/:id/decide accepts allow-session", async () => {
  const gate = createApprovalGate({ dataDir: createTempDir() });
  gate.registerExecutor("skill-write", () => "created");
  const outcome = await gate.requestApproval("skill-write", { payload: {} });

  const app = buildApp(gate);
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/approvals/${outcome.requestId}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow-session" }),
    });
    assert.equal(response.status, 200);
    assert.equal(gate.isGranted("skill-write"), true);
  });
});

test("#669 tool approval mode: smart by default, env next, a saved choice wins; POST is admin-gated and validated", async () => {
  const dataDir = createTempDir();
  const gate = createApprovalGate({ dataDir });
  let admin = false;
  const checkAdminAuth = (req, res) => {
    if (!admin) res.status(401).json({ ok: false, error: "unauthorized" });
    return admin;
  };
  const get = async (baseUrl) => (await (await fetch(`${baseUrl}/approvals/tool-mode`)).json()).mode;
  const post = (baseUrl, body) =>
    fetch(`${baseUrl}/approvals/tool-mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  await withServer(buildApp(gate, { checkAdminAuth, env: {} }), async (baseUrl) => {
    assert.equal(await get(baseUrl), "smart");
  });
  await withServer(buildApp(gate, { checkAdminAuth, env: { MANA_TOOL_APPROVAL: "ask" } }), async (baseUrl) => {
    assert.equal(await get(baseUrl), "ask");

    assert.equal((await post(baseUrl, { mode: "off" })).status, 401);
    admin = true;
    assert.equal((await post(baseUrl, { mode: "everything" })).status, 400);
    const saved = await post(baseUrl, { mode: "off" });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { mode: "off" });
    assert.equal(await get(baseUrl), "off", "saved choice beats MANA_TOOL_APPROVAL");
  });
  assert.equal(createApprovalGate({ dataDir }).getToolApprovalMode(), "off", "persisted");
});

test("#1154: never is remembered, listed with always, and Forget clears either (admin only)", async () => {
  const gate = createApprovalGate({ dataDir: createTempDir() });
  const ask = (site) => {
    gate.registerExecutor(`browser-site:${site}`, () => "ok");
    return gate.requestApproval(`browser-site:${site}`, { summary: site, payload: { site } });
  };
  await gate.decide((await ask("a.test")).requestId, "always-allow");

  let admin = true;
  const app = buildApp(gate, { checkAdminAuth: (req, res) => admin || (res.status(401).json({ error: "no" }), false) });
  await withServer(app, async (baseUrl) => {
    const b = await ask("b.test");
    const decided = await fetch(`${baseUrl}/approvals/${b.requestId}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "never" }),
    });
    assert.equal((await decided.json()).status, "denied");
    assert.deepEqual(await ask("b.test"), { status: "blocked", actionType: "browser-site:b.test", never: true, reason: "you said never for this" });

    const listed = await (await fetch(`${baseUrl}/approvals/remembered`)).json();
    assert.deepEqual(listed.remembered, [
      { key: "browser-site:a.test", answer: "always" },
      { key: "browser-site:b.test", answer: "never" },
    ]);

    const forget = (key) =>
      fetch(`${baseUrl}/approvals/remembered/forget`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
    assert.deepEqual(await (await forget("browser-site:b.test")).json(), { forgotten: true });
    assert.equal((await ask("b.test")).status, "pending");
    assert.deepEqual(await (await forget("browser-site:zzz")).json(), { forgotten: false });

    admin = false;
    assert.equal((await fetch(`${baseUrl}/approvals/remembered`)).status, 401);
    assert.equal((await forget("browser-site:a.test")).status, 401);
  });
  assert.equal(gate.isGranted("browser-site:a.test"), true);
});

test("#1191: the Git and GitHub approval modes default per tier, save per tier (admin only), and persist", async () => {
  const dataDir = createTempDir();
  const gate = createApprovalGate({ dataDir });
  let admin = false;
  const app = buildApp(gate, { checkAdminAuth: (req, res) => admin || (res.status(401).json({ error: "no" }), false) });
  await withServer(app, async (baseUrl) => {
    const get = async () => (await (await fetch(`${baseUrl}/approvals/git-mode`)).json()).modes;
    const post = (body) =>
      fetch(`${baseUrl}/approvals/git-mode`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.deepEqual(await get(), { local: "once", github: "once", danger: "ask" });
    assert.equal((await post({ tier: "danger", mode: "off" })).status, 401);
    admin = true;
    assert.equal((await post({ tier: "__proto__", mode: "off" })).status, 400);
    assert.equal((await post({ tier: "danger", mode: "always" })).status, 400);
    const saved = await post({ tier: "danger", mode: "off" });
    assert.deepEqual((await saved.json()).modes, { local: "once", github: "once", danger: "off" });
  });
  assert.deepEqual(createApprovalGate({ dataDir }).getGitApprovalModes(), { danger: "off" }, "persisted");
});
