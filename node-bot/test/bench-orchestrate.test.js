// #1467: the "Pro orchestrates, Flash works" setup. The orchestrator can read, search, plan and test but not edit, and gets
// one more tool, self_work__delegate({brief}); a delegation runs a worker loop with the full tools in the same worktree.
const assert = require("node:assert/strict");
const test = require("node:test");

const { CODING_EDIT_TOOL_NAME, CODING_TEST_TOOL_NAME } = require("../ai/coding-tool-source");
const { SESSION_GOAL_FINISH_TOOL_NAME } = require("../ai/session-goal-tool-source");
const { orchestrate, DELEGATE_TOOL } = require("../bench/orchestrate");
const { DELETE_TOOL_NAME } = require("../self-work");

const tool = (name) => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } });
const names = (policy) => policy.tools.map((t) => t.function.name);

function basePolicy(log = [], overrides = {}) {
  return {
    tools: ["self_work__read", CODING_EDIT_TOOL_NAME, DELETE_TOOL_NAME, CODING_TEST_TOOL_NAME, SESSION_GOAL_FINISH_TOOL_NAME].map(tool),
    async executeTool(name, args) {
      log.push([name, args]);
      if (overrides[name]) return overrides[name](args);
      if (name === CODING_EDIT_TOOL_NAME) return JSON.stringify({ status: "ok" });
      if (name === CODING_TEST_TOOL_NAME) return JSON.stringify({ passed: true, output: "ok 1 - works" });
      if (name === SESSION_GOAL_FINISH_TOOL_NAME) return JSON.stringify({ status: "ok", finished: true });
      return "{}";
    },
  };
}

test("the orchestrator sees delegate and no edit tool; the worker sees the edit tools and no delegate", async () => {
  let orchestratorTools;
  let workerTools;
  const run = orchestrate({
    orchestratorLoop: async (prompt, policy) => {
      orchestratorTools = names(policy);
      await policy.executeTool(DELEGATE_TOOL, { brief: "Change a.js: return 2. Run test/a.test.js." });
      return { content: "done" };
    },
    workerLoop: async (prompt, policy) => {
      workerTools = names(policy);
      await policy.executeTool(CODING_EDIT_TOOL_NAME, { path: "a.js" });
      await policy.executeTool(SESSION_GOAL_FINISH_TOOL_NAME, { reason: "done" });
      return { content: "changed a.js" };
    },
  });
  await run("issue text", basePolicy(), {});
  assert.ok(orchestratorTools.includes(DELEGATE_TOOL));
  assert.ok(!orchestratorTools.includes(CODING_EDIT_TOOL_NAME) && !orchestratorTools.includes(DELETE_TOOL_NAME));
  assert.ok(orchestratorTools.includes(CODING_TEST_TOOL_NAME) && orchestratorTools.includes(SESSION_GOAL_FINISH_TOOL_NAME));
  assert.ok(workerTools.includes(CODING_EDIT_TOOL_NAME) && workerTools.includes(DELETE_TOOL_NAME));
  assert.ok(!workerTools.includes(DELEGATE_TOOL));
});

test("a delegation returns the worker's summary, files and last test; its edits go through the real executeTool", async () => {
  const log = [];
  const results = [];
  const run = orchestrate({
    orchestratorLoop: async (prompt, policy) => {
      results.push(JSON.parse(await policy.executeTool(DELEGATE_TOOL, { brief: "Edit a.js and test it." })));
      return { content: "ok" };
    },
    workerLoop: async (prompt, policy) => {
      assert.match(prompt, /Edit a\.js and test it\./);
      await policy.executeTool(CODING_EDIT_TOOL_NAME, { path: "a.js" });
      await policy.executeTool(CODING_TEST_TOOL_NAME, {});
      await policy.executeTool(SESSION_GOAL_FINISH_TOOL_NAME, { reason: "edited a.js" });
      return { content: "I edited a.js." };
    },
  });
  await run("issue", basePolicy(log), {});
  assert.deepEqual(results[0], { status: "done", summary: "I edited a.js.", files: ["a.js"], lastTest: { passed: true, output: "ok 1 - works" } });
  assert.ok(log.some(([n, a]) => n === CODING_EDIT_TOOL_NAME && a.path === "a.js"), "the edit reached the real policy");
  assert.ok(!log.some(([n]) => n === SESSION_GOAL_FINISH_TOOL_NAME), "the worker's finish never reaches the real run, only the orchestrator's does");
});

test("an empty brief starts no worker and returns no-changes", async () => {
  let started = 0;
  const results = [];
  const run = orchestrate({
    orchestratorLoop: async (prompt, policy) => {
      results.push(JSON.parse(await policy.executeTool(DELEGATE_TOOL, { brief: "   " })));
      return { content: "ok" };
    },
    workerLoop: async () => { started += 1; return { content: "" }; },
  });
  await run("issue", basePolicy(), {});
  assert.equal(started, 0);
  assert.equal(results[0].status, "no-changes");
});

test("a worker that edits nothing is no-changes; one that hits a block is stuck; the orchestrator carries on", async () => {
  const results = [];
  let call = 0;
  const run = orchestrate({
    orchestratorLoop: async (prompt, policy) => {
      results.push(JSON.parse(await policy.executeTool(DELEGATE_TOOL, { brief: "look at it" })));
      results.push(JSON.parse(await policy.executeTool(DELEGATE_TOOL, { brief: "edit it" })));
      return { content: "ok" };
    },
    workerLoop: async (prompt, policy) => {
      call += 1;
      if (call === 2) await policy.executeTool(CODING_EDIT_TOOL_NAME, { path: "b.js" });
      return { content: "stopped" };
    },
  });
  await run("issue", basePolicy([], { [CODING_EDIT_TOOL_NAME]: () => JSON.stringify({ status: "blocked", error: "stuck" }) }), {});
  assert.equal(results[0].status, "no-changes");
  assert.equal(results[1].status, "stuck");
});

test("the orchestrator cannot edit even by naming the tool", async () => {
  let error;
  const run = orchestrate({
    orchestratorLoop: async (prompt, policy) => {
      try { await policy.executeTool(CODING_EDIT_TOOL_NAME, { path: "a.js" }); } catch (e) { error = e; }
      return { content: "ok" };
    },
    workerLoop: async () => ({ content: "" }),
  });
  await run("issue", basePolicy(), {});
  assert.match(error.message, /delegate/);
});
