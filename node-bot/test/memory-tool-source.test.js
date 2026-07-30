const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MEMORY_TOOL_PREFIX,
  TOOL_SCHEMAS,
  isMemoryToolName,
  createMemoryToolSource,
  buildToolPolicyWithMemory,
} = require("../ai/memory-tool-source");

function fakeAcpMemoryStore(rememberFactImpl, listFactKeysImpl) {
  const calls = [];
  return {
    calls,
    rememberFact: (args) => {
      calls.push(args);
      return rememberFactImpl ? rememberFactImpl(args) : { ok: true, action: args.action || "insert" };
    },
    ...(listFactKeysImpl ? { listFactKeys: listFactKeysImpl } : {}),
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

test("listToolSchemas skims existing fact keys into the tool description so the model reuses a key instead of duplicating", () => {
  const acpMemoryStore = fakeAcpMemoryStore(null, () => [
    { key: "the user's GPU", preview: "RTX 5080" },
    { key: "favorite color", preview: "teal" },
  ]);
  const source = createMemoryToolSource({ acpMemoryStore });
  const description = source.listToolSchemas()[0].function.description;
  assert.match(description, /the user's GPU/);
  assert.match(description, /RTX 5080/);
  assert.match(description, /favorite color/);
  assert.match(description, /reuse that exact key with action "patch"/);
});

test("listToolSchemas falls back to the static baseline when acpMemoryStore has no listFactKeys or no facts yet", () => {
  const noMethodSource = createMemoryToolSource({ acpMemoryStore: fakeAcpMemoryStore() });
  assert.deepEqual(noMethodSource.listToolSchemas(), TOOL_SCHEMAS);

  const emptySource = createMemoryToolSource({ acpMemoryStore: fakeAcpMemoryStore(null, () => []) });
  assert.deepEqual(emptySource.listToolSchemas(), TOOL_SCHEMAS);
});

test("executeTool forwards key/text/action to acpMemoryStore.rememberFact, with the bound sessionId", async () => {
  const acpMemoryStore = fakeAcpMemoryStore();
  const source = createMemoryToolSource({ acpMemoryStore, sessionId: "session-a" });
  const result = await source.executeTool(`${MEMORY_TOOL_PREFIX}remember`, {
    key: "the user's GPU",
    text: "RTX 5080",
    action: "patch",
  });
  assert.deepEqual(acpMemoryStore.calls, [
    { sessionId: "session-a", key: "the user's GPU", text: "RTX 5080", action: "patch" },
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

test("executeTool stages the write through approvalGate.requestApproval when one is provided, instead of writing immediately", async () => {
  const acpMemoryStore = fakeAcpMemoryStore();
  const approvalCalls = [];
  const approvalGate = {
    requestApproval: async (actionType, details) => {
      approvalCalls.push({ actionType, details });
      return { status: "pending", requestId: "req-1", summary: details.summary, flags: [] };
    },
  };
  const source = createMemoryToolSource({ acpMemoryStore, sessionId: "session-a", approvalGate });

  const result = await source.executeTool(`${MEMORY_TOOL_PREFIX}remember`, {
    key: "the user's GPU",
    text: "RTX 5080",
    action: "patch",
  });

  // Nothing written to the store yet -- only staged as a pending request.
  assert.equal(acpMemoryStore.calls.length, 0);
  assert.equal(approvalCalls.length, 1);
  assert.equal(approvalCalls[0].actionType, "memory-write");
  assert.deepEqual(approvalCalls[0].details.payload, {
    sessionId: "session-a",
    key: "the user's GPU",
    text: "RTX 5080",
    action: "patch",
  });
  assert.equal(approvalCalls[0].details.scanText, "RTX 5080");
  assert.deepEqual(JSON.parse(result), {
    status: "pending",
    requestId: "req-1",
    summary: approvalCalls[0].details.summary,
    flags: [],
  });
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
