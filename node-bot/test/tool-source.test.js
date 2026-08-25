const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { buildToolPolicy } = require("../ai/tool-source");
const { createMemoryToolSource } = require("../ai/memory-tool-source");
const { createSessionSearchToolSource } = require("../ai/session-search-tool-source");
const { createSkillToolSource } = require("../ai/skill-tool-source");
const { createSnapshotToolSource } = require("../ai/snapshot-tool-source");
const { createMcpClientRegistry } = require("../mcp-client-registry");

function fakeBasePolicy() {
  return {
    tools: [{ type: "function", function: { name: "read_file" } }],
    isKnownTool: (name) => name === "read_file",
    executeTool: async (name) => `base:${name}`,
  };
}

function fakeToolSource(prefix, schemas) {
  const calls = [];
  return {
    calls,
    listToolSchemas: () => schemas,
    isKnownToolName: (name) => typeof name === "string" && name.startsWith(prefix),
    executeTool: async (name, args) => {
      calls.push({ name, args });
      return `${prefix}result:${name}`;
    },
  };
}

test("buildToolPolicy merges every source's schemas onto the base policy's", async () => {
  const source1 = fakeToolSource("a__", [{ type: "function", function: { name: "a__one" } }]);
  const source2 = fakeToolSource("b__", [{ type: "function", function: { name: "b__two" } }]);

  const merged = await buildToolPolicy(fakeBasePolicy(), [source1, source2]);

  assert.deepEqual(
    merged.tools.map((t) => t.function.name),
    ["read_file", "a__one", "b__two"],
  );
});

test("buildToolPolicy dispatches to whichever source's isKnownToolName matches, else falls back to the base policy", async () => {
  const source1 = fakeToolSource("a__", []);
  const source2 = fakeToolSource("b__", []);
  const merged = await buildToolPolicy(fakeBasePolicy(), [source1, source2]);

  assert.equal(await merged.executeTool("read_file", {}), "base:read_file");
  assert.equal(await merged.executeTool("a__one", { x: 1 }), "a__result:a__one");
  assert.equal(await merged.executeTool("b__two", {}), "b__result:b__two");
  assert.deepEqual(source1.calls, [{ name: "a__one", args: { x: 1 } }]);
});

test("buildToolPolicy's isKnownTool checks the base policy and every source", async () => {
  const source1 = fakeToolSource("a__", []);
  const merged = await buildToolPolicy(fakeBasePolicy(), [source1]);

  assert.equal(merged.isKnownTool("read_file"), true);
  assert.equal(merged.isKnownTool("a__one"), true);
  assert.equal(merged.isKnownTool("nope"), false);
});

test("buildToolPolicy awaits a source whose listToolSchemas() returns a promise (the MCP registry shape)", async () => {
  const asyncSource = {
    listToolSchemas: async () => [{ type: "function", function: { name: "mcp__tool" } }],
    isKnownToolName: (name) => name.startsWith("mcp__"),
    executeTool: async (name) => `mcp:${name}`,
  };
  const merged = await buildToolPolicy(fakeBasePolicy(), [asyncSource]);

  assert.deepEqual(
    merged.tools.map((t) => t.function.name),
    ["read_file", "mcp__tool"],
  );
  assert.equal(await merged.executeTool("mcp__tool", {}), "mcp:mcp__tool");
});

test("buildToolPolicy with an empty/missing source list just passes the base policy through unchanged (shape-wise)", async () => {
  const base = fakeBasePolicy();
  const merged = await buildToolPolicy(base, []);
  assert.deepEqual(merged.tools, base.tools);
  assert.equal(merged.isKnownTool("read_file"), true);
  assert.equal(await merged.executeTool("read_file", {}), "base:read_file");

  const mergedNoArg = await buildToolPolicy(base, undefined);
  assert.deepEqual(mergedNoArg.tools, base.tools);
});

// Issue #267 pass 5's finding: the tests above only ever exercise
// buildToolPolicy against hand-rolled fakeToolSource() objects, never the
// real factories server.js actually assembles (createMemoryToolSource,
// createSessionSearchToolSource, createSkillToolSource,
// createMcpClientRegistry). A copy-paste miss on any one factory's
// isKnownToolName/listToolSchemas alias would only surface as a runtime
// TypeError the first time a model actually calls a tool from that source --
// exactly the "mocks passed, real wiring was broken" failure class this
// codebase already hit once (see CHANGELOG's runOpenAIReply scope bug).
test("buildToolPolicy works end to end with the real memory/session-search/skill/mcp-registry factories, not just fakes", async () => {
  const rememberCalls = [];
  const acpMemoryStore = {
    rememberFact: (args) => {
      rememberCalls.push(args);
      return { ok: true, action: args.action || "insert" };
    },
    searchSessions: () => [],
  };
  const memorySource = createMemoryToolSource({ acpMemoryStore, sessionId: "s1" });
  const sessionSearchSource = createSessionSearchToolSource({ acpMemoryStore, sessionId: "s1" });
  const skillSource = createSkillToolSource({
    approvalGate: {
      requestApproval: async () => ({ status: "pending" }),
      // Issue #355: the tool source registers a "skill-run" executor at
      // construction, so a stub has to match the real gate's interface.
      registerExecutor: () => {},
    },
    skillsStore: { viewSkill: () => null },
  });
  const snapshotSource = createSnapshotToolSource({
    approvalGate: {
      requestApproval: async () => ({ status: "pending" }),
      registerExecutor: () => {},
    },
    snapshotStore: { listSnapshots: () => [], getSnapshot: () => null, checkStale: () => ({ stale: false }), restoreSnapshot: async () => ({}) },
  });
  const mcpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-tool-source-mcp-"));
  const mcpRegistry = createMcpClientRegistry({ dataDir: mcpDataDir });

  const sources = [memorySource, sessionSearchSource, skillSource, snapshotSource, mcpRegistry];
  for (const source of sources) {
    assert.equal(typeof source.isKnownToolName, "function", "every real source must expose isKnownToolName");
    assert.equal(typeof source.listToolSchemas, "function", "every real source must expose listToolSchemas");
  }

  const basePolicy = {
    tools: [{ type: "function", function: { name: "read_file" } }],
    isKnownTool: (name) => name === "read_file",
    executeTool: async (name) => `base:${name}`,
  };
  const merged = await buildToolPolicy(basePolicy, sources);

  // Real dispatch through the merged policy, not just presence checks --
  // proves the aliases actually route to the right underlying source.
  const result = await merged.executeTool("memory__remember", { key: "k", text: "t" });
  assert.deepEqual(JSON.parse(result), { ok: true, action: "insert" });
  assert.equal(rememberCalls.length, 1);

  assert.equal(merged.isKnownTool("memory__remember"), true);
  assert.equal(merged.isKnownTool("session_search__query"), true);
  assert.equal(merged.isKnownTool("skill__view"), true);
  assert.equal(merged.isKnownTool("snapshot__list"), true);
  assert.equal(merged.isKnownTool("mcp__anything"), true);
  assert.equal(merged.isKnownTool("read_file"), true);
  assert.equal(merged.isKnownTool("totally_unrelated"), false);
});
