const assert = require("node:assert/strict");
const test = require("node:test");

const {
  EXPRESSION_TOOL_PREFIX,
  TOOL_SCHEMAS,
  MAX_EXPRESSION_NAME_CHARS,
  isExpressionToolName,
  createExpressionToolSource,
} = require("../ai/expression-tool-source");

test("isExpressionToolName distinguishes expression tool names from anything else", () => {
  assert.equal(isExpressionToolName(`${EXPRESSION_TOOL_PREFIX}set`), true);
  assert.equal(isExpressionToolName("read_file"), false);
  assert.equal(isExpressionToolName("memory__remember"), false);
  assert.equal(isExpressionToolName(undefined), false);
});

test("listToolSchemas returns the set tool schema, requiring no options", () => {
  const source = createExpressionToolSource();
  assert.deepEqual(source.listToolSchemas(), TOOL_SCHEMAS);
});

test("executeTool returns the chosen expression name wrapped in a JSON object", async () => {
  const source = createExpressionToolSource();
  const result = await source.executeTool(`${EXPRESSION_TOOL_PREFIX}set`, { name: "wink" });
  assert.deepEqual(JSON.parse(result), { ok: true, expression: "wink" });
});

test("executeTool trims whitespace and clamps to MAX_EXPRESSION_NAME_CHARS", async () => {
  const source = createExpressionToolSource();
  const result = await source.executeTool(`${EXPRESSION_TOOL_PREFIX}set`, {
    name: `  ${"x".repeat(100)}  `,
  });
  const parsed = JSON.parse(result);
  assert.equal(parsed.expression.length, MAX_EXPRESSION_NAME_CHARS);
  assert.equal(parsed.expression, "x".repeat(MAX_EXPRESSION_NAME_CHARS));
});

test("executeTool rejects a missing or empty name", async () => {
  const source = createExpressionToolSource();
  await assert.rejects(
    () => source.executeTool(`${EXPRESSION_TOOL_PREFIX}set`, {}),
    /name is required/,
  );
  await assert.rejects(
    () => source.executeTool(`${EXPRESSION_TOOL_PREFIX}set`, { name: "   " }),
    /name is required/,
  );
});

test("executeTool rejects an unrecognized expression tool name", async () => {
  const source = createExpressionToolSource();
  await assert.rejects(
    () => source.executeTool(`${EXPRESSION_TOOL_PREFIX}reset-everything`, {}),
    /unknown expression tool/,
  );
});
