const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MEMORY_TOOL_PREFIX,
  TOOL_SCHEMAS,
  isMemoryToolName,
  createMemoryToolSource,
  buildToolPolicyWithMemory,
} = require("../ai/memory-tool-source");

function fakeAcpMemoryStore(rememberFactImpl) {
  const calls = [];
  return {
    calls,
    rememberFact: (args) => {
      calls.push(args);
      return rememberFactImpl ? rememberFactImpl(args) : { ok: true, action: args.action || "insert" };
    },
  };
}

test("createMemoryToolSource requires acpMemoryStore", () => {
  assert.throws(() => createMemoryToolSource({}), /acpMemoryStore is required/);
});

test("isMemoryToolName distinguishes memory tool names from anything else", () => {
  assert.equal(isMemoryToolName(`${MEMORY_TOOL_PREFIX}remember`), true);
  assert.equal(isMemoryToolName("read_file"), false);
  assert.equal(isMemoryToolName("browser_automation__navigate"), false);
  assert.equal(isMemoryToolName(undefined), false);
});

test("listToolSchemas returns the remember tool schema", () => {
  const source = createMemoryToolSource({ acpMemoryStore: fakeAcpMemoryStore() });
  assert.deepEqual(source.listToolSchemas(), TOOL_SCHEMAS);
});

test("executeTool forwards key/text/action to acpMemoryStore.rememberFact, with the bound sessionId", async () => {
  const acpMemoryStore = fakeAcpMemoryStore();
  const source = createMemoryToolSource({ acpMemoryStore, sessionId: "session-a" });
  const result = await source.executeTool(`${MEMORY_TOOL_PREFIX}remember`, {
    key: "Aurora's GPU",
    text: "RTX 5080",
    action: "patch",
  });
  assert.deepEqual(acpMemoryStore.calls, [
    { sessionId: "session-a", key: "Aurora's GPU", text: "RTX 5080", action: "patch" },
  ]);
  assert.equal(result, JSON.stringify({ ok: true, action: "patch" }));
});

test("executeTool rejects an unrecognized memory tool name", async () => {
  const source = createMemoryToolSource({ acpMemoryStore: fakeAcpMemoryStore() });
  await assert.rejects(
    () => source.executeTool(`${MEMORY_TOOL_PREFIX}forget-everything`, {}),
    /unknown memory tool/,
  );
});

test("executeTool propagates a validation error from acpMemoryStore.rememberFact (e.g. missing key)", async () => {
  const acpMemoryStore = fakeAcpMemoryStore(() => {
    throw new Error("key is required");
  });
  const source = createMemoryToolSource({ acpMemoryStore });
  await assert.rejects(
    () => source.executeTool(`${MEMORY_TOOL_PREFIX}remember`, { text: "no key given" }),
    /key is required/,
  );
});

test("buildToolPolicyWithMemory merges the remember tool into an existing base policy", async () => {
  const acpMemoryStore = fakeAcpMemoryStore();
  const memorySource = createMemoryToolSource({ acpMemoryStore, sessionId: "s1" });
  const basePolicy = {
    tools: [{ type: "function", function: { name: "read_file" } }],
    isKnownTool: (name) => name === "read_file",
    executeTool: async (name) => `base:${name}`,
  };

  const merged = await buildToolPolicyWithMemory(basePolicy, memorySource);

  assert.equal(merged.tools.length, 2);
  assert.equal(merged.isKnownTool("read_file"), true);
  assert.equal(merged.isKnownTool(`${MEMORY_TOOL_PREFIX}remember`), true);
  assert.equal(merged.isKnownTool("something_else"), false);

  assert.equal(await merged.executeTool("read_file", {}), "base:read_file");
  await merged.executeTool(`${MEMORY_TOOL_PREFIX}remember`, { key: "k", text: "t" });
  assert.equal(acpMemoryStore.calls.length, 1);
});
