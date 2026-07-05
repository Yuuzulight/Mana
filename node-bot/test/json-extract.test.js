const test = require("node:test");
const assert = require("node:assert");
const { extractJsonFromText, safeJsonParse } = require("../utils/json-extract");

test("JSON Extraction Utility Suite", async (t) => {
  await t.test("should parse a pure JSON object", () => {
    const input = '{"done": true, "message": "success"}';
    const expected = { done: true, message: "success" };
    assert.deepStrictEqual(extractJsonFromText(input), expected);
  });

  await t.test("should parse a pure JSON array", () => {
    const input = '[{"tool": "file_read", "args": {"path": "main.js"}}]';
    const expected = [{ tool: "file_read", args: { path: "main.js" } }];
    assert.deepStrictEqual(extractJsonFromText(input), expected);
  });

  await t.test("should extract JSON with conversational prefix text", () => {
    const input =
      'Sure! Here is the data block:\n{"status": "active", "id": 101}';
    const expected = { status: "active", id: 101 };
    assert.deepStrictEqual(extractJsonFromText(input), expected);
  });

  await t.test("should handle nested braces inside a quoted string", () => {
    const input =
      'Logs parsed: {"code_snippet": "function clear() { return {}; }", "valid": true}';
    const expected = {
      code_snippet: "function clear() { return {}; }",
      valid: true,
    };
    assert.deepStrictEqual(extractJsonFromText(input), expected);
  });

  await t.test("should safely return null when no JSON is present", () => {
    const input = "Hello! I am Mana. How can I help you today?";
    assert.strictEqual(extractJsonFromText(input), null);
  });

  await t.test(
    "should extract the first valid JSON block if multiple exist",
    () => {
      const input =
        'First config: {"id": 1} followed by second config: {"id": 2}';
      const expected = { id: 1 };
      assert.deepStrictEqual(extractJsonFromText(input), expected);
    },
  );

  await t.test("safeJsonParse wrapper should delegate correctly", () => {
    const input = '{"wrapped": true}';
    const expected = { wrapped: true };
    assert.deepStrictEqual(safeJsonParse(input), expected);
  });
});
