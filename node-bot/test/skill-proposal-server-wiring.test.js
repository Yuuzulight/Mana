// Round-2 review finding: skill-proposal.js's own unit tests only ever
// exercise it through fully-mocked deps, which is exactly how a real
// ReferenceError (runOpenAIReply referenced from the wrong function scope
// when createSkillProposalRunner was built) shipped without any test
// catching it -- the crash only showed up booting the real server.js. These
// tests boot a real createApp() instead of mocking skill-proposal.js's
// dependencies, so a future scope/wiring regression fails here.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createApp } = require("../server");
const { createApprovalGate } = require("../approval-gate");
const { createSkillsStore } = require("../skills-store");
const { IDLE_SKILL_WRITE_ACTION } = require("../skill-proposal");
const { withServer } = require("./helpers");

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mana-${label}-`));
}

test("real server.js wiring: createApp() doesn't crash building the skill-proposal runner", () => {
  const skillsStore = createSkillsStore({ skillsDir: tmpDir("skills") });
  const approvalGate = createApprovalGate({ dataDir: tmpDir("approval") });
  assert.doesNotThrow(() => createApp({ skillsStore, approvalGate }));
});

test("real server.js wiring: POST /skills/propose runs the real pass without crashing", async () => {
  const skillsStore = createSkillsStore({ skillsDir: tmpDir("skills") });
  const approvalGate = createApprovalGate({ dataDir: tmpDir("approval") });
  const app = createApp({ skillsStore, approvalGate });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/skills/propose`, { method: "POST" });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(typeof payload.ok, "boolean");
    assert.notEqual(payload.reason, "exception", payload.error);
  });
});

test("real server.js wiring: skill-write-idle executor registered by registerRoutes persists a real skill", async () => {
  const skillsStore = createSkillsStore({ skillsDir: tmpDir("skills") });
  const approvalGate = createApprovalGate({ dataDir: tmpDir("approval") });
  createApp({ skillsStore, approvalGate }); // wires the real executors onto this approvalGate

  const outcome = await approvalGate.requestApproval(IDLE_SKILL_WRITE_ACTION, {
    summary: "test proposal",
    payload: {
      name: "Integration Test Skill",
      description: "exercises the real skill-write-idle executor wiring",
      body: "do the thing",
    },
  });
  assert.equal(outcome.status, "pending");

  const decided = await approvalGate.decide(outcome.requestId, "allow-once");
  assert.equal(decided.status, "approved");
  assert.equal(decided.result.name, "Integration Test Skill");
  assert.ok(skillsStore.listSkills().some((s) => s.name === "Integration Test Skill"));
});
