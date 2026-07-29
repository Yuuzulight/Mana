const assert = require("node:assert/strict");
const test = require("node:test");

const {
  SESSION_SEARCH_TOOL_PREFIX,
  TOOL_SCHEMAS,
  isSessionSearchToolName,
  createSessionSearchToolSource,
  buildToolPolicyWithSessionSearch,
} = require("../ai/session-search-tool-source");

function fakeAcpMemoryStore(searchImpl) {
  const calls = [];
  return {
    calls,
    searchSessions: (args) => {
      calls.push(args);
      return searchImpl ? searchImpl(args) : [];
    },
  };
}

test("createSessionSearchToolSource requires acpMemoryStore", () => {
  assert.throws(() => createSessionSearchToolSource({}), /acpMemoryStore is required/);
});

test("isSessionSearchToolName distinguishes session_search tool names from anything else", () => {
  assert.equal(isSessionSearchToolName(`${SESSION_SEARCH_TOOL_PREFIX}query`), true);
  assert.equal(isSessionSearchToolName("read_file"), false);
  assert.equal(isSessionSearchToolName(`memory__remember`), false);
  assert.equal(isSessionSearchToolName(undefined), false);
});

test("listToolSchemas returns the query tool schema", () => {
  const source = createSessionSearchToolSource({ acpMemoryStore: fakeAcpMemoryStore() });
  assert.deepEqual(source.listToolSchemas(), TOOL_SCHEMAS);
});

test("executeTool defaults to this_session scope, binding the tool source's own sessionId", async () => {
  const acpMemoryStore = fakeAcpMemoryStore();
  const source = createSessionSearchToolSource({ acpMemoryStore, sessionId: "session-a" });
  await source.executeTool(`${SESSION_SEARCH_TOOL_PREFIX}query`, { query: "docker" });
  assert.deepEqual(acpMemoryStore.calls, [
    { query: "docker", sort: undefined, sessionId: "session-a", limit: 20 },
  ]);
});

test("executeTool with scope=all_sessions omits the sessionId filter", async () => {
  const acpMemoryStore = fakeAcpMemoryStore();
  const source = createSessionSearchToolSource({ acpMemoryStore, sessionId: "session-a" });
  await source.executeTool(`${SESSION_SEARCH_TOOL_PREFIX}query`, {
    query: "docker",
    scope: "all_sessions",
    sort: "newest",
  });
  assert.deepEqual(acpMemoryStore.calls, [
    { query: "docker", sort: "newest", sessionId: undefined, limit: 20 },
  ]);
});

test("executeTool returns results wrapped in a JSON object", async () => {
  const acpMemoryStore = fakeAcpMemoryStore(() => [
    { sessionId: "s1", role: "user", text: "docker question", at: "t1" },
  ]);
  const source = createSessionSearchToolSource({ acpMemoryStore });
  const result = await source.executeTool(`${SESSION_SEARCH_TOOL_PREFIX}query`, { query: "docker" });
  assert.deepEqual(JSON.parse(result), {
    results: [{ sessionId: "s1", role: "user", text: "docker question", at: "t1" }],
  });
});

test("executeTool rejects an unrecognized session_search tool name", async () => {
  const source = createSessionSearchToolSource({ acpMemoryStore: fakeAcpMemoryStore() });
  await assert.rejects(
    () => source.executeTool(`${SESSION_SEARCH_TOOL_PREFIX}delete-everything`, {}),
    /unknown session_search tool/,
  );
});

test("buildToolPolicyWithSessionSearch merges the query tool into an existing base policy", async () => {
  const acpMemoryStore = fakeAcpMemoryStore();
  const searchSource = createSessionSearchToolSource({ acpMemoryStore, sessionId: "s1" });
  const basePolicy = {
    tools: [{ type: "function", function: { name: "read_file" } }],
    isKnownTool: (name) => name === "read_file",
    executeTool: async (name) => `base:${name}`,
  };

  const merged = await buildToolPolicyWithSessionSearch(basePolicy, searchSource);

  assert.equal(merged.tools.length, 2);
  assert.equal(merged.isKnownTool("read_file"), true);
  assert.equal(merged.isKnownTool(`${SESSION_SEARCH_TOOL_PREFIX}query`), true);
  assert.equal(merged.isKnownTool("something_else"), false);

  assert.equal(await merged.executeTool("read_file", {}), "base:read_file");
  await merged.executeTool(`${SESSION_SEARCH_TOOL_PREFIX}query`, { query: "q" });
  assert.equal(acpMemoryStore.calls.length, 1);
});
