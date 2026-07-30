const assert = require("node:assert/strict");
const test = require("node:test");

const {
  SKILL_TOOL_PREFIX,
  TOOL_SCHEMAS,
  isSkillToolName,
  createSkillToolSource,
  buildToolPolicyWithSkillCreate,
} = require("../ai/skill-tool-source");

function fakeApprovalGate({ requestThrows } = {}) {
  const requestCalls = [];
  return {
    requestCalls,
    requestApproval: async (actionType, details) => {
      requestCalls.push({ actionType, details });
      if (requestThrows) throw requestThrows;
      return { status: "pending", requestId: "req-1", summary: details.summary, flags: [] };
    },
  };
}

function fakeSkillsStore(skills = {}) {
  return {
    viewSkill: (name) => skills[name] || null,
  };
}

test("createSkillToolSource requires approvalGate", () => {
  assert.throws(() => createSkillToolSource({ skillsStore: fakeSkillsStore() }), /approvalGate is required/);
});

test("createSkillToolSource requires skillsStore", () => {
  assert.throws(() => createSkillToolSource({ approvalGate: fakeApprovalGate() }), /skillsStore is required/);
});

test("isSkillToolName distinguishes skill tool names from anything else", () => {
  assert.equal(isSkillToolName(`${SKILL_TOOL_PREFIX}create`), true);
  assert.equal(isSkillToolName("memory__remember"), false);
  assert.equal(isSkillToolName(undefined), false);
});

test("listToolSchemas returns view/run/create tool schemas", () => {
  const source = createSkillToolSource({ approvalGate: fakeApprovalGate(), skillsStore: fakeSkillsStore() });
  assert.deepEqual(source.listToolSchemas(), TOOL_SCHEMAS);
  assert.deepEqual(
    TOOL_SCHEMAS.map((t) => t.function.name),
    [`${SKILL_TOOL_PREFIX}view`, `${SKILL_TOOL_PREFIX}run`, `${SKILL_TOOL_PREFIX}create`],
  );
});

test("skill__view returns the full body of a known skill", async () => {
  const skillsStore = fakeSkillsStore({
    "Restart SearXNG": { name: "Restart SearXNG", description: "d", body: "1. do a thing" },
  });
  const source = createSkillToolSource({ approvalGate: fakeApprovalGate(), skillsStore });

  const result = await source.executeTool(`${SKILL_TOOL_PREFIX}view`, { name: "Restart SearXNG" });
  assert.deepEqual(JSON.parse(result), {
    status: "ok",
    name: "Restart SearXNG",
    description: "d",
    body: "1. do a thing",
  });
});

test("skill__view returns a JSON error for an unknown skill instead of throwing", async () => {
  const source = createSkillToolSource({ approvalGate: fakeApprovalGate(), skillsStore: fakeSkillsStore() });
  const result = await source.executeTool(`${SKILL_TOOL_PREFIX}view`, { name: "nope" });
  assert.deepEqual(JSON.parse(result), { status: "error", error: 'no skill named "nope"' });
});

test("skill__run executes a skill's bundled script and returns its result", async () => {
  const skillsStore = fakeSkillsStore({
    Doubler: { name: "Doubler", body: "Steps:\n```skill-script\nreturn 21 * 2;\n```" },
  });
  const runScript = async (code) => {
    assert.equal(code, "return 21 * 2;");
    return { result: 42, logs: [] };
  };
  const source = createSkillToolSource({ approvalGate: fakeApprovalGate(), skillsStore, runScript });

  const result = await source.executeTool(`${SKILL_TOOL_PREFIX}run`, { name: "Doubler" });
  assert.deepEqual(JSON.parse(result), { status: "ok", result: 42, logs: [] });
});

test("skill__view includes declared inputs when the skill has a ```skill-inputs block", async () => {
  const skillsStore = fakeSkillsStore({
    Greeter: {
      name: "Greeter",
      description: "d",
      body: "Steps:\n```skill-inputs\nname: the person to greet\n```\n```skill-script\nreturn `hi ${inputs.name}`;\n```",
    },
  });
  const source = createSkillToolSource({ approvalGate: fakeApprovalGate(), skillsStore });

  const result = await source.executeTool(`${SKILL_TOOL_PREFIX}view`, { name: "Greeter" });
  assert.deepEqual(JSON.parse(result).inputs, [{ name: "name", description: "the person to greet" }]);
});

test("skill__view omits the inputs field for a skill with no ```skill-inputs block", async () => {
  const skillsStore = fakeSkillsStore({
    "Restart SearXNG": { name: "Restart SearXNG", description: "d", body: "1. do a thing" },
  });
  const source = createSkillToolSource({ approvalGate: fakeApprovalGate(), skillsStore });

  const result = await source.executeTool(`${SKILL_TOOL_PREFIX}view`, { name: "Restart SearXNG" });
  assert.equal("inputs" in JSON.parse(result), false);
});

test("skill__run passes a model-supplied inputs object through to runScript", async () => {
  const skillsStore = fakeSkillsStore({
    Greeter: {
      name: "Greeter",
      body: "```skill-inputs\nname: the person to greet\n```\n```skill-script\nreturn `hi ${inputs.name}`;\n```",
    },
  });
  const runScript = async (code, options) => {
    assert.deepEqual(options, { inputs: { name: "Mana" } });
    return { result: "hi Mana", logs: [] };
  };
  const source = createSkillToolSource({ approvalGate: fakeApprovalGate(), skillsStore, runScript });

  const result = await source.executeTool(`${SKILL_TOOL_PREFIX}run`, { name: "Greeter", inputs: { name: "Mana" } });
  assert.deepEqual(JSON.parse(result), { status: "ok", result: "hi Mana", logs: [] });
});

test("skill__run returns a JSON error when the skill has no script block", async () => {
  const skillsStore = fakeSkillsStore({ Prose: { name: "Prose", body: "just steps, no code" } });
  const source = createSkillToolSource({ approvalGate: fakeApprovalGate(), skillsStore });

  const result = await source.executeTool(`${SKILL_TOOL_PREFIX}run`, { name: "Prose" });
  assert.deepEqual(JSON.parse(result), { status: "error", error: '"Prose" has no ```skill-script block' });
});

test("skill__run returns a JSON error instead of throwing when the script itself fails", async () => {
  const skillsStore = fakeSkillsStore({
    Broken: { name: "Broken", body: "```skill-script\nthrow new Error('bad');\n```" },
  });
  const runScript = async () => {
    throw new Error("bad");
  };
  const source = createSkillToolSource({ approvalGate: fakeApprovalGate(), skillsStore, runScript });

  const result = await source.executeTool(`${SKILL_TOOL_PREFIX}run`, { name: "Broken" });
  assert.deepEqual(JSON.parse(result), { status: "error", error: "bad" });
});

test("executeTool stages through approvalGate and leaves it pending -- never auto-decides", async () => {
  const approvalGate = fakeApprovalGate();
  const source = createSkillToolSource({ approvalGate, skillsStore: fakeSkillsStore() });

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

  // No approvalGate.decide anywhere on this source -- a model-drafted
  // skill is never self-approved, unlike the Settings UI's own create flow.
  assert.equal(typeof approvalGate.decide, "undefined");
  assert.deepEqual(JSON.parse(result), {
    status: "pending",
    requestId: "req-1",
    summary: approvalGate.requestCalls[0].details.summary,
    flags: [],
  });
});

test("executeTool returns a JSON error instead of throwing when requestApproval itself fails", async () => {
  const approvalGate = fakeApprovalGate({ requestThrows: new Error("approval gate unavailable") });
  const source = createSkillToolSource({ approvalGate, skillsStore: fakeSkillsStore() });

  const result = await source.executeTool(`${SKILL_TOOL_PREFIX}create`, {
    name: "Dup",
    description: "d",
    body: "b",
  });

  assert.deepEqual(JSON.parse(result), {
    status: "error",
    error: "approval gate unavailable",
  });
});

test("executeTool rejects an unrecognized skill tool name", async () => {
  const source = createSkillToolSource({ approvalGate: fakeApprovalGate(), skillsStore: fakeSkillsStore() });
  await assert.rejects(
    () => source.executeTool(`${SKILL_TOOL_PREFIX}delete-everything`, {}),
    /unknown skill tool/,
  );
});

test("buildToolPolicyWithSkillCreate merges skill tools into an existing base policy", async () => {
  const approvalGate = fakeApprovalGate();
  const skillSource = createSkillToolSource({ approvalGate, skillsStore: fakeSkillsStore() });
  const basePolicy = {
    tools: [{ type: "function", function: { name: "read_file" } }],
    isKnownTool: (name) => name === "read_file",
    executeTool: async (name) => `base:${name}`,
  };

  const merged = await buildToolPolicyWithSkillCreate(basePolicy, skillSource);

  assert.equal(merged.tools.length, 4);
  assert.equal(merged.isKnownTool("read_file"), true);
  assert.equal(merged.isKnownTool(`${SKILL_TOOL_PREFIX}create`), true);
  assert.equal(merged.isKnownTool("something_else"), false);

  assert.equal(await merged.executeTool("read_file", {}), "base:read_file");
  await merged.executeTool(`${SKILL_TOOL_PREFIX}create`, { name: "n", description: "d", body: "b" });
  assert.equal(approvalGate.requestCalls.length, 1);
});
