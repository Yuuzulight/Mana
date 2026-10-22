// #1406: Claude Code over ACP as one more runner for her self-work loop, with
// only her tools (through her own policy) and nothing of its own.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createClaudeCodeRunner, claudeCodeAvailable, DENIED_BUILTINS } = require("../ai/claude-code-runner");

const FAKE = path.join(__dirname, "fixtures", "fake-acp-agent.js");

function setup(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-claude-runner-"));
  const log = path.join(dir, "agent.log");
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, FAKE_ACP_MODE: mode, FAKE_ACP_LOG: log, ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: "http://host", CLAUDE_CODE_OAUTH_TOKEN: "x", CLAUDECODE: "1", USE_STAGING_OAUTH: "1" };
  const seen = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { dir, env, seen, command: process.execPath, args: [FAKE] };
}

function policy(log = []) {
  return {
    tools: [{ type: "function", function: { name: "self_work__read", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
    isKnownTool: () => true,
    async executeTool(name, args) {
      log.push([name, args]);
      return "1: function add(a, b) {";
    },
  };
}

test("starts a session with none of Claude Code's own tools, her MCP endpoint only, and the model", async () => {
  const s = setup("finish");
  const runner = createClaudeCodeRunner({ command: s.command, args: s.args, env: s.env, worktree: s.dir });
  await runner("Implement #1", policy(), {});
  const { sessionNew } = s.seen().find((e) => e.sessionNew);
  const options = sessionNew._meta.claudeCode.options;
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.disallowedTools, DENIED_BUILTINS);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.model, "sonnet");
  assert.equal(sessionNew.cwd, s.dir);
  assert.equal(sessionNew.mcpServers.length, 1);
  assert.equal(new URL(sessionNew.mcpServers[0].url).hostname, "127.0.0.1");
  assert.match(sessionNew.mcpServers[0].headers.find((h) => h.name === "Authorization").value, /^Bearer \S{20,}$/);
});

test("its env has no ANTHROPIC_*, CLAUDE* or USE_*_OAUTH variable", async () => {
  const s = setup("finish");
  await createClaudeCodeRunner({ command: s.command, args: s.args, env: s.env, worktree: s.dir })("Implement #1", policy(), {});
  assert.deepEqual(s.seen().find((e) => e.env).env, []);
});

test("its tool calls reach her policy; it may use her tools and nothing else", async () => {
  const s = setup("finish");
  const calls = [];
  await createClaudeCodeRunner({ command: s.command, args: s.args, env: s.env, worktree: s.dir })("Implement #1", policy(calls), {});
  assert.deepEqual(calls, [["self_work__read", { path: "a.js" }]]);
  const { permissions } = s.seen().find((e) => e.permissions);
  assert.deepEqual(permissions.mana, { outcome: "selected", optionId: "a" });
  assert.deepEqual(permissions.shell, { outcome: "selected", optionId: "r" });
});

test("content is its final message, rounds its tool calls, usage its tokens", async () => {
  const s = setup("finish");
  const out = await createClaudeCodeRunner({ command: s.command, args: s.args, env: s.env, worktree: s.dir })("Implement #1", policy(), {});
  assert.equal(out.content, "I fixed add() and the tests pass.");
  assert.equal(out.rounds, 1);
  assert.equal(out.usage.totalTokens, 100);
  assert.equal(out.usageLimit, undefined);
});

test("a usage limit comes back as usageLimit, not a thrown error", async () => {
  const s = setup("limit");
  const out = await createClaudeCodeRunner({ command: s.command, args: s.args, env: s.env, worktree: s.dir })("Implement #1", policy(), {});
  assert.equal(out.usageLimit, true);
  assert.match(out.content, /usage limit/i);
});

test("signed out: the run says to sign in, and claudeCodeAvailable says it first", async () => {
  const s = setup("signed-out");
  const out = await createClaudeCodeRunner({ command: s.command, args: s.args, env: s.env, worktree: s.dir })("Implement #1", policy(), {});
  assert.match(out.unavailable, /run `claude`, then `\/login`/);
  assert.match(await claudeCodeAvailable({ command: s.command, args: s.args, env: s.env }), /run `claude`, then `\/login`/);
  assert.equal(await claudeCodeAvailable({ command: s.command, args: s.args, env: setup("finish").env }), null);
});

test("not installed: claudeCodeAvailable says so instead of throwing", async () => {
  const s = setup("finish");
  assert.match(await claudeCodeAvailable({ command: s.command, args: [path.join(s.dir, "missing.js")], env: s.env }), /isn't installed/);
});
