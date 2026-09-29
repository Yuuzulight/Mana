// Issue #669: the reply path wraps tools with the approval mode saved via
// Settings > Approvals (approval-gate settings), not just MANA_TOOL_APPROVAL.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createApp } = require("../server");
const { createApprovalGate } = require("../approval-gate");

async function finishGoalWith(approvalGate, replyMeta = {}) {
  let outcome = null;
  const app = createApp({
    env: { ...process.env, MANA_TOOL_CALLING_ENABLED: "1", MANA_TOOL_APPROVAL: "" },
    approvalGate,
    llamaServerRuntime: { isEnabled: () => true },
    runToolAwareReply: async (prompt, toolPolicy) => {
      outcome = await toolPolicy.executeTool("session_goal__finish", { summary: "done" });
      return { content: "ok", toolCalls: [], rounds: 1 };
    },
  });
  app.locals.acpMemoryStore.ensureSession({ sessionId: "sess-669" });
  app.locals.acpMemoryStore.setSessionGoal("sess-669", "Ship it");
  await app.locals.buildAssistantReply("hi", "", "", "default", "sess-669", null, null, replyMeta);
  return outcome;
}

test("#669 the reply's tool gate uses the saved approval mode (smart by default)", async () => {
  const originalMemoryDir = process.env.MANA_ACP_MEMORY_DIR;
  const originalToolCalling = process.env.MANA_TOOL_CALLING_ENABLED;
  process.env.MANA_ACP_MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mana-acp-memory-"));
  process.env.MANA_TOOL_CALLING_ENABLED = "1";
  try {
    const gate = createApprovalGate({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-approval-")) });
    // smart: a read-tier built-in runs without a prompt
    assert.doesNotMatch(String(await finishGoalWith(gate)), /"pending"/);

    gate.setToolApprovalMode("ask");
    assert.equal(JSON.parse(await finishGoalWith(gate)).status, "pending");

    // #699: a heartbeat check's own gate replaces the risk gate.
    let wrappedWith = null;
    const wrapToolPolicy = (policy, approvalGate) => ((wrappedWith = approvalGate), policy);
    assert.doesNotMatch(String(await finishGoalWith(gate, { wrapToolPolicy })), /"pending"/);
    assert.equal(wrappedWith, gate);
  } finally {
    fs.rmSync(process.env.MANA_ACP_MEMORY_DIR, { recursive: true, force: true });
    for (const [key, value] of [
      ["MANA_ACP_MEMORY_DIR", originalMemoryDir],
      ["MANA_TOOL_CALLING_ENABLED", originalToolCalling],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
