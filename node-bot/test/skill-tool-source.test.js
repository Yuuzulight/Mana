const assert = require("node:assert/strict");
const test = require("node:test");

const {
  SKILL_TOOL_PREFIX,
  TOOL_SCHEMAS,
  isSkillToolName,
  createSkillToolSource,
  buildToolPolicyWithSkillCreate,
} = require("../ai/skill-tool-source");

function fakeApprovalGate({ decideResult, decideThrows } = {}) {
  const requestCalls = [];
  const decideCalls = [];
  return {
    requestCalls,
    decideCalls,
    requestApproval: async (actionType, details) => {
      requestCalls.push({ actionType, details });
      return { status: "pending", requestId: "req-1", summary: details.summary, flags: [] };
    },
    decide: async (requestId, decision) => {
      decideCalls.push({ requestId, decision });
      if (decideThrows) throw decideThrows;
      return decideResult || { status: "approved", requestId, actionType: "skill-write", result: { name: "ok" } };
    },
  };
}

test("createSkillToolSource requires approvalGate", () => {
  assert.throws(() => createSkillToolSource({}), /approvalGate is required/);
});

test("isSkillToolName distinguishes skill tool names from anything else", () => {
  assert.equal(isSkillToolName(`${SKILL_TOOL_PREFIX}create`), true);
  assert.equal(isSkillToolName("memory__remember"), false);
  assert.equal(isSkillToolName(undefined), false);
});

test("listToolSchemas returns the create tool schema", () => {
  const source = createSkillToolSource({ approvalGate: fakeApprovalGate() });
  assert.deepEqual(source.listToolSchemas(), TOOL_SCHEMAS);
});

test("executeTool stages through approvalGate then auto-decides allow-once, since the user asked for this directly", async () => {
  const approvalGate = fakeApprovalGate();
  const source = createSkillToolSource({ approvalGate });

  const result = await source.executeTool(`${SKILL_TOOL_PREFIX}create`, {
    name: "Restart SearXNG",
    description: "How to bring web search back up.",
    body: "1. Check the process.\n2. Restart it.",
  });

  assert.equal(approvalGate.requestCalls.length, 1);
  assert.equal(approvalGate.requestCalls[0].actionType, "skill-write");
  assert.deepEqual(approvalGate.requestCalls[0].details.payload, {
    name: "Restart SearXNG",
    description: "How to bring web search back up.",
    body: "1. Check the process.\n2. Restart it.",
    category: undefined,
  });
  assert.equal(approvalGate.requestCalls[0].details.scanText, "1. Check the process.\n2. Restart it.");

  assert.equal(approvalGate.decideCalls.length, 1);
  assert.deepEqual(approvalGate.decideCalls[0], { requestId: "req-1", decision: "allow-once" });

  assert.deepEqual(JSON.parse(result), {
    status: "approved",
    requestId: "req-1",
    actionType: "skill-write",
    result: { name: "ok" },
  });
});

test("executeTool returns a JSON error instead of throwing when the skill write fails (e.g. duplicate name)", async () => {
  const approvalGate = fakeApprovalGate({ decideThrows: new Error('a skill named "Dup" already exists') });
  const source = createSkillToolSource({ approvalGate });

  const result = await source.executeTool(`${SKILL_TOOL_PREFIX}create`, {
    name: "Dup",
    description: "d",
    body: "b",
  });

  assert.deepEqual(JSON.parse(result), {
    status: "error",
    error: 'a skill named "Dup" already exists',
  });
});

test("executeTool rejects an unrecognized skill tool name", async () => {
  const source = createSkillToolSource({ approvalGate: fakeApprovalGate() });
  await assert.rejects(
    () => source.executeTool(`${SKILL_TOOL_PREFIX}delete-everything`, {}),
    /unknown skill tool/,
  );
});

test("buildToolPolicyWithSkillCreate merges the create tool into an existing base policy", async () => {
  const approvalGate = fakeApprovalGate();
  const skillSource = createSkillToolSource({ approvalGate });
  const basePolicy = {
    tools: [{ type: "function", function: { name: "read_file" } }],
    isKnownTool: (name) => name === "read_file",
    executeTool: async (name) => `base:${name}`,
  };

  const merged = await buildToolPolicyWithSkillCreate(basePolicy, skillSource);

  assert.equal(merged.tools.length, 2);
  assert.equal(merged.isKnownTool("read_file"), true);
  assert.equal(merged.isKnownTool(`${SKILL_TOOL_PREFIX}create`), true);
  assert.equal(merged.isKnownTool("something_else"), false);

  assert.equal(await merged.executeTool("read_file", {}), "base:read_file");
  await merged.executeTool(`${SKILL_TOOL_PREFIX}create`, { name: "n", description: "d", body: "b" });
  assert.equal(approvalGate.requestCalls.length, 1);
});
