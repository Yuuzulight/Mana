const assert = require("node:assert/strict");
const test = require("node:test");

const { buildToolPolicy } = require("../ai/tool-source");

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
