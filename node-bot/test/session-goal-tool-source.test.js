const assert = require("node:assert/strict");
const test = require("node:test");

const {
  SESSION_GOAL_TOOL_PREFIX,
  SESSION_GOAL_FINISH_TOOL_NAME,
  TOOL_SCHEMAS,
  isSessionGoalToolName,
  createSessionGoalToolSource,
} = require("../ai/session-goal-tool-source");

test("isSessionGoalToolName distinguishes session_goal tool names from anything else", () => {
  assert.equal(isSessionGoalToolName(SESSION_GOAL_FINISH_TOOL_NAME), true);
  assert.equal(isSessionGoalToolName("read_file"), false);
  assert.equal(isSessionGoalToolName("vision__look"), false);
  assert.equal(isSessionGoalToolName(undefined), false);
});

test("listToolSchemas returns the finish tool schema, requiring no options", () => {
  const source = createSessionGoalToolSource();
  assert.deepEqual(source.listToolSchemas(), TOOL_SCHEMAS);
});

test("executeTool returns a finished result with the given reason", async () => {
  const source = createSessionGoalToolSource();
  const result = await source.executeTool(SESSION_GOAL_FINISH_TOOL_NAME, {
    reason: "The login bug is fixed and tests pass.",
  });
  assert.deepEqual(JSON.parse(result), {
    status: "ok",
    finished: true,
    reason: "The login bug is fixed and tests pass.",
  });
});

test("executeTool rejects a missing or empty reason", async () => {
  const source = createSessionGoalToolSource();
  await assert.rejects(
    () => source.executeTool(SESSION_GOAL_FINISH_TOOL_NAME, {}),
    /reason is required/,
  );
  await assert.rejects(
    () => source.executeTool(SESSION_GOAL_FINISH_TOOL_NAME, { reason: "   " }),
    /reason is required/,
  );
});

test("executeTool rejects an unrecognized session_goal tool name", async () => {
  const source = createSessionGoalToolSource();
  await assert.rejects(
    () => source.executeTool(`${SESSION_GOAL_TOOL_PREFIX}set`, {}),
    /unknown session_goal tool/,
  );
});
