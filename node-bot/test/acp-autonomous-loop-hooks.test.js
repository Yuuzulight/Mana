// #838: the user's hooks.json rules in Pipeline B (acp-autonomous-loop.js).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  executeAutonomousStep,
  resetSessionToolCounts,
  MAX_TOOL_CALLS_PER_SESSION,
} = require("../acp-autonomous-loop");
const { createHooksStore } = require("../hooks-store");
const { waitForPendingFile } = require("./helpers");

function hooksWith(...rules) {
  const store = createHooksStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-pb-hooks-")) });
  for (const rule of rules) store.addRule(rule);
  return store;
}

const step = (tool, args) => JSON.stringify([{ tool, args }]);

test("a modify-input rewrite still goes through the tool's own guards", async () => {
  const hooksStore = hooksWith({ phase: "pre", action: "modify-input", toolName: "file_read", set: { path: "../../outside.txt" } });

  const res = await executeAutonomousStep(step("file_read", { path: "README.md" }), "pb-rewrite", { hooksStore });

  assert.equal(res.results[0].status, "error");
  assert.equal(res.results[0].detail, "path_outside_repo");
});

test("a deny rule is reported as a result and still counts toward the #396 cap", async () => {
  resetSessionToolCounts("pb-deny");
  const hooksStore = hooksWith({ phase: "pre", action: "deny", toolName: "file_read", reason: "no reading today" });

  const first = await executeAutonomousStep(step("file_read", { path: "README.md" }), "pb-deny", { hooksStore });
  assert.deepEqual(first.results[0], { tool: "file_read", status: "denied", detail: "no reading today" });

  let last;
  for (let i = 0; i < MAX_TOOL_CALLS_PER_SESSION; i++) {
    last = await executeAutonomousStep(step("file_read", { path: "README.md" }), "pb-deny", { hooksStore });
  }
  assert.equal(last.results[0].detail, "session_cap_exceeded");
  resetSessionToolCounts("pb-deny");
});

test("an ask rule waits for a person: approved runs the call, a timeout rejects it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-pb-ask-"));
  const saved = { dir: process.env.MANA_PENDING_WRITES_DIR, timeout: process.env.FILE_WRITE_APPROVAL_TIMEOUT_MS };
  process.env.MANA_PENDING_WRITES_DIR = dir;
  try {
    const hooksStore = hooksWith({ phase: "pre", action: "ask", toolName: "file_read", reason: "check reads" });

    const running = executeAutonomousStep(step("file_read", { path: "README.md" }), "pb-ask", { hooksStore });
    const pendingFile = await waitForPendingFile(dir);
    const pending = JSON.parse(fs.readFileSync(path.join(dir, pendingFile), "utf8"));
    assert.equal(pending.kind, "hook-ask");
    assert.equal(pending.tool, "file_read");
    assert.equal(pending.reason, "check reads");
    fs.writeFileSync(path.join(dir, pendingFile.replace(/\.json$/, ".approved.json")), JSON.stringify({ approver: "test" }));
    const approved = await running;
    assert.equal(approved.results[0].status, "ok");

    process.env.FILE_WRITE_APPROVAL_TIMEOUT_MS = "30";
    const timedOut = await executeAutonomousStep(step("file_read", { path: "README.md" }), "pb-ask", { hooksStore });
    assert.deepEqual(timedOut.results[0], { tool: "file_read", status: "rejected", detail: "approval_timeout" });
  } finally {
    for (const [key, value] of [["MANA_PENDING_WRITES_DIR", saved.dir], ["FILE_WRITE_APPROVAL_TIMEOUT_MS", saved.timeout]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deny wins over ask, matched on the rewritten args", async () => {
  const hooksStore = hooksWith(
    { phase: "pre", action: "modify-input", toolName: "file_read", set: { path: "secret.txt" } },
    { phase: "pre", action: "ask", toolName: "file_read" },
    { phase: "pre", action: "deny", toolName: "file_read", pathContains: "secret", reason: "not that one" },
  );

  const res = await executeAutonomousStep(step("file_read", { path: "README.md" }), "pb-order", { hooksStore });

  assert.deepEqual(res.results[0], { tool: "file_read", status: "denied", detail: "not that one" });
});
