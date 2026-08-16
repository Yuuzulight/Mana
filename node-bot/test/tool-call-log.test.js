const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createToolCallLog, wrapWithToolCallLog } = require("../tool-call-log");

function createTempLogPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mana-tool-call-log-")), "tool-calls.jsonl");
}

test("readRecent returns an empty array when nothing has been logged yet", () => {
  const log = createToolCallLog({ logPath: createTempLogPath() });
  assert.deepEqual(log.readRecent(), []);
});

test("append writes one JSON line per entry, readRecent returns them in order", () => {
  const log = createToolCallLog({ logPath: createTempLogPath(), now: () => "2026-07-28T00:00:00.000Z" });
  log.append({ name: "read_file", args: { path: "a.txt" }, ok: true, durationMs: 5 });
  log.append({ name: "read_file", args: { path: "b.txt" }, ok: false, error: "not found", durationMs: 2 });

  const recent = log.readRecent();
  assert.equal(recent.length, 2);
  assert.equal(recent[0].name, "read_file");
  assert.equal(recent[0].at, "2026-07-28T00:00:00.000Z");
  assert.equal(recent[1].ok, false);
  assert.equal(recent[1].error, "not found");
});

test("readRecent respects the limit and returns the most recent entries", () => {
  const log = createToolCallLog({ logPath: createTempLogPath() });
  for (let i = 0; i < 5; i += 1) {
    log.append({ name: "read_file", args: { i }, ok: true });
  }
  const recent = log.readRecent(2);
  assert.equal(recent.length, 2);
  assert.deepEqual(JSON.parse(recent[0].args), { i: 3 });
  assert.deepEqual(JSON.parse(recent[1].args), { i: 4 });
});

test("append truncates very large args instead of writing an unbounded log line", () => {
  const log = createToolCallLog({ logPath: createTempLogPath() });
  const hugeArgs = { text: "x".repeat(5000) };
  log.append({ name: "type", args: hugeArgs, ok: true });
  const [entry] = log.readRecent();
  assert.ok(entry.args.length < 2100);
  assert.match(entry.args, /\.\.\.\[truncated\]$/);
});

test("wrapWithToolCallLog logs a successful call and returns the real result unchanged", async () => {
  const log = createToolCallLog({ logPath: createTempLogPath() });
  const basePolicy = {
    tools: [{ type: "function", function: { name: "read_file" } }],
    isKnownTool: (name) => name === "read_file",
    executeTool: async (name, args) => `contents of ${args.path}`,
  };
  const wrapped = wrapWithToolCallLog(basePolicy, log);

  const result = await wrapped.executeTool("read_file", { path: "notes.txt" });
  assert.equal(result, "contents of notes.txt");

  const [entry] = log.readRecent();
  assert.equal(entry.name, "read_file");
  assert.equal(entry.ok, true);
  assert.equal(typeof entry.durationMs, "number");
});

test("wrapWithToolCallLog logs a failed call and still rethrows the original error", async () => {
  const log = createToolCallLog({ logPath: createTempLogPath() });
  const basePolicy = {
    tools: [],
    isKnownTool: () => true,
    executeTool: async () => {
      throw new Error("boom");
    },
  };
  const wrapped = wrapWithToolCallLog(basePolicy, log);

  await assert.rejects(() => wrapped.executeTool("read_file", {}), /boom/);

  const [entry] = log.readRecent();
  assert.equal(entry.ok, false);
  assert.equal(entry.error, "boom");
});

test("wrapWithToolCallLog passes tools/isKnownTool through unchanged", () => {
  const log = createToolCallLog({ logPath: createTempLogPath() });
  const basePolicy = {
    tools: [{ type: "function", function: { name: "read_file" } }],
    isKnownTool: (name) => name === "read_file",
    executeTool: async () => "x",
  };
  const wrapped = wrapWithToolCallLog(basePolicy, log);
  assert.strictEqual(wrapped.tools, basePolicy.tools);
  assert.equal(wrapped.isKnownTool("read_file"), true);
  assert.equal(wrapped.isKnownTool("nope"), false);
});

test("append redacts credential-shaped argument names (issue #348)", () => {
  const log = createToolCallLog({ logPath: createTempLogPath() });
  log.append({
    name: "http_request",
    args: {
      url: "https://example.test/v1",
      api_key: "super-secret-value",
      headers: { Authorization: "Bearer abcdefghijklmnop0123456789" },
      nested: [{ accessToken: "another-secret" }],
    },
    ok: true,
  });

  const [entry] = log.readRecent();
  assert.doesNotMatch(entry.args, /super-secret-value/);
  assert.doesNotMatch(entry.args, /another-secret/);
  assert.match(entry.args, /\[redacted\]/);
  // Non-credential arguments stay intact -- the log is useless if it
  // redacts the fields that make a call identifiable.
  assert.match(entry.args, /example\.test/);
});

test("append keeps a memory `key` argument, which is not a credential (issue #348)", () => {
  const log = createToolCallLog({ logPath: createTempLogPath() });
  log.append({ name: "remember", args: { key: "favorite color", text: "teal" }, ok: true });

  const [entry] = log.readRecent();
  assert.match(entry.args, /favorite color/);
  assert.doesNotMatch(entry.args, /\[redacted\]/);
});

test("append redacts a token embedded in a URL value (issue #348)", () => {
  const log = createToolCallLog({ logPath: createTempLogPath() });
  log.append({
    name: "fetch",
    args: { url: "https://example.test/data?api_key=zzzzzzzzzzzzzzzzzzzz&page=2" },
    ok: true,
  });

  const [entry] = log.readRecent();
  assert.doesNotMatch(entry.args, /zzzzzzzzzzzzzzzzzzzz/);
  assert.match(entry.args, /\[redacted\]/);
});

test("append redacts a credential quoted back inside an error message (issue #348)", () => {
  const log = createToolCallLog({ logPath: createTempLogPath() });
  log.append({
    name: "http_request",
    args: {},
    ok: false,
    error: "401 rejected for Authorization: Bearer abcdefghijklmnop0123456789",
  });

  const [entry] = log.readRecent();
  assert.doesNotMatch(entry.error, /abcdefghijklmnop0123456789/);
  assert.match(entry.error, /\[redacted\]/);
});

test("append survives a circular args object without throwing (issue #348)", () => {
  const log = createToolCallLog({ logPath: createTempLogPath() });
  const args = { name: "loop" };
  args.self = args;
  log.append({ name: "weird_tool", args, ok: true });

  const [entry] = log.readRecent();
  assert.match(entry.args, /circular/);
});

test("append keeps a shared (non-circular) object reference intact (issue #348)", () => {
  const log = createToolCallLog({ logPath: createTempLogPath() });
  const shared = { region: "eu-west" };
  log.append({ name: "deploy", args: { primary: shared, secondary: shared }, ok: true });

  const [entry] = log.readRecent();
  // Referenced twice side by side is a shared reference, not a cycle.
  assert.doesNotMatch(entry.args, /circular/);
  assert.equal((entry.args.match(/eu-west/g) || []).length, 2);
});
