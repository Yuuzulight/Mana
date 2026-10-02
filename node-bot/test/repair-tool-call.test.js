const test = require("node:test");
const assert = require("node:assert/strict");
const {
  repairJsonString,
  parseRepairedJson,
  repairToolCallText,
} = require("../utils/repair-tool-call");

test("repair-tool-call suite (#621)", async (t) => {
  await t.test("repairJsonString fixes doubled braces", () => {
    assert.equal(
      repairJsonString('{{ "name": "read_file", "arguments": {} }}'),
      '{"name": "read_file", "arguments": {}}',
    );
    assert.equal(
      repairJsonString('{{"name": "test"}}'),
      '{"name": "test"}',
    );
  });

  await t.test("repairJsonString strips trailing commas in objects and arrays", () => {
    assert.equal(
      repairJsonString('{"a": 1, "b": 2,}'),
      '{"a": 1, "b": 2}',
    );
    assert.equal(
      repairJsonString('{"items": [1, 2, 3,],}'),
      '{"items": [1, 2, 3]}',
    );
  });

  await t.test("repairJsonString escapes unescaped Windows backslashes", () => {
    const raw = '{"path": "C:\\Users\\User\\project\\file.txt"}';
    const parsed = parseRepairedJson(raw);
    assert.ok(parsed);
    assert.match(parsed.path, /file\.txt/);
  });

  await t.test("repairToolCallText extracts tool call from markdown code fence", () => {
    const content = '```json\n{"name": "read_file", "arguments": {"path": "notes.txt"}}\n```';
    const calls = repairToolCallText(content, [{ function: { name: "read_file" } }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "read_file");
    assert.deepEqual(calls[0].arguments, { path: "notes.txt" });
  });

  await t.test("repairToolCallText extracts tool call from <tool_call> tags", () => {
    const content = '<tool_call>\n{"name": "read_file", "arguments": {"path": "todo.md"}}\n</tool_call>';
    const calls = repairToolCallText(content, [{ function: { name: "read_file" } }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "read_file");
    assert.deepEqual(calls[0].arguments, { path: "todo.md" });
  });

  await t.test("repairToolCallText extracts Qwen XML function calls", () => {
    const content = '<function=read_file><parameter=path>src/index.js</parameter></function>';
    const calls = repairToolCallText(content, [{ function: { name: "read_file" } }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "read_file");
    assert.deepEqual(calls[0].arguments, { path: "src/index.js" });
  });

  await t.test("repairToolCallText repairs doubled braces and trailing commas in one shot", () => {
    const content = '{{"name": "read_file", "arguments": {"path": "README.md",},}}';
    const calls = repairToolCallText(content, [{ function: { name: "read_file" } }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "read_file");
    assert.deepEqual(calls[0].arguments, { path: "README.md" });
  });

  await t.test("repairToolCallText supports ACP-style tool/args objects", () => {
    const content = '```json\n[{"tool": "file_read", "args": {"path": "config.json"}}]\n```';
    const calls = repairToolCallText(content);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "file_read");
    assert.equal(calls[0].tool, "file_read");
    assert.deepEqual(calls[0].args, { path: "config.json" });
  });

  await t.test("repairToolCallText filters out tools not in provided tools list", () => {
    const content = '{"name": "unknown_tool", "arguments": {"x": 1}}';
    const calls = repairToolCallText(content, [{ function: { name: "read_file" } }]);
    assert.equal(calls.length, 0);
  });

  await t.test("repairToolCallText returns empty array for conversational text", () => {
    const content = "Hello! I can help you with your files today. What would you like to do?";
    const calls = repairToolCallText(content, [{ function: { name: "read_file" } }]);
    assert.equal(calls.length, 0);
  });

  await t.test("parses mockModelReply with Windows path", () => {
    const mockModelReply =
      'Fetch file:\n[{"tool":"file_read","args":{"path":"C:\\Windows\\system.ini"}}]';
    const calls = repairToolCallText(mockModelReply);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, "file_read");
    assert.equal(calls[0].args.path, "C:\\Windows\\system.ini");
  });
});

