// #1203: the self-work benchmark runner, on a throwaway repo with a fake
// model. Real git, real hidden test run.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const { runCase, verifyCase, writeReport, summarize, failureKind } = require("../bench/self-work-bench");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: "pipe" }).trim();
}

const bases = [];
test.after(() => bases.forEach((b) => fs.rmSync(b, { recursive: true, force: true })));

// A repo whose second commit fixes add() and adds the test for it, and a
// live node_modules folder the worktrees link to.
function makeRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mana-bench-"));
  bases.push(base);
  const repo = path.join(base, "repo");
  fs.mkdirSync(path.join(repo, "node-bot", "test"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
  fs.writeFileSync(path.join(repo, "node-bot", "util.js"), "function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const baseSha = git(repo, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "node-bot", "util.js"), "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n");
  fs.writeFileSync(
    path.join(repo, "node-bot", "test", "util.test.js"),
    'const test = require("node:test");\nconst assert = require("node:assert");\ntest("adds", () => assert.equal(require("../util").add(2, 3), 5));\n',
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fix");
  const fixSha = git(repo, "rev-parse", "HEAD");
  fs.mkdirSync(path.join(repo, "node-bot", "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node-bot", "node_modules", "dep", "index.js"), "// live\n");
  const c = {
    id: "1-add-subtracts",
    issue: 1,
    title: "add() subtracts",
    body: "add(2, 3) gives -1.",
    base: baseSha,
    fix: fixSha,
    fixFiles: ["node-bot/util.js"],
    hiddenTests: ["node-bot/test/util.test.js"],
    testCommand: "node --test test/util.test.js",
    interface: "`add(a, b)` from node-bot/util.js.",
  };
  return { repo, worktrees: path.join(base, "worktrees"), c };
}

// A model that makes the given tool calls, in one round each.
function fakeModel(calls, tokens) {
  return async (prompt, policy, opts) => {
    assert.match(prompt, /add\(2, 3\) gives -1\.\n\nThe tests for this will use: `add\(a, b\)` from node-bot\/util\.js/);
    const toolCalls = [];
    for (const [name, args] of calls) {
      opts.onRound?.(toolCalls.length + 1, opts.maxRounds);
      await policy.executeTool(name, args);
      toolCalls.push({ name, args, ok: true });
      tokens.prompt += 100;
      tokens.completion += 10;
      tokens.peak = Math.max(tokens.peak, 100 * toolCalls.length);
    }
    return { content: "Fixed add().", toolCalls, rounds: toolCalls.length };
  };
}

const edit = (p, oldText, newText) => ["coding__propose_edit", { path: p, old_text: oldText, new_text: newText, summary: "fix" }];
const finish = ["session_goal__finish", { reason: "fixed" }];

function deps(r, calls) {
  const tokens = { prompt: 0, completion: 0, peak: 0, textCalls: 0 };
  return { repoRoot: r.repo, worktreesDir: r.worktrees, runLoop: fakeModel(calls, tokens), tokens, ramPercent: () => 50, onEvent: () => {}, sample: async () => ({ vramMb: 9000, ramPercent: 80 }) };
}

test("a case that fixes the bug passes its hidden test, and the worktree is gone after", async () => {
  const r = makeRepo();
  const result = await runCase(r.c, deps(r, [edit("node-bot/util.js", "a - b", "a + b"), finish]));

  assert.equal(result.passed, true, result.hiddenTail);
  assert.equal(result.ended, "finished");
  assert.equal(result.rounds, 2);
  assert.equal(result.toolCalls, 2);
  assert.equal(result.toolErrors, 0);
  assert.deepEqual([result.peakVramMb, result.peakRamPercent, result.failure], [9000, 80, null]);
  assert.deepEqual(result.tokens, { prompt: 200, completion: 20, peak: 200, textCalls: 0, tps: null });
  assert.deepEqual(result.diff, { files: ["node-bot/util.js"], added: 1, removed: 1 });
  assert.deepEqual(result.outside, []);
  assert.match(result.patch, /\+  return a \+ b;/);
  // Cleaned up: the worktree, and only the link to the live packages.
  assert.equal(fs.existsSync(path.join(r.worktrees, "bench-1-add-subtracts")), false);
  assert.doesNotMatch(git(r.repo, "worktree", "list"), /bench-1-add/);
  assert.equal(fs.readFileSync(path.join(r.repo, "node-bot", "node_modules", "dep", "index.js"), "utf8"), "// live\n");
  // Nothing landed on the repo's own branch.
  assert.equal(git(r.repo, "rev-parse", "HEAD"), r.c.fix);
});

test("a wrong fix fails the hidden test, and files outside the real fix are named", async () => {
  const r = makeRepo();
  const result = await runCase(
    r.c,
    deps(r, [edit("node-bot/util.js", "a - b", "a * b"), edit("node-bot/extra.js", "", "module.exports = 1;\n")]),
  );

  assert.equal(result.passed, false);
  assert.equal(result.ended, "not-finished");
  assert.deepEqual(result.outside, ["node-bot/extra.js"]);
  assert.match(result.hiddenTail, /fail/i);
  assert.equal(fs.existsSync(path.join(r.worktrees, "bench-1-add-subtracts")), false);
});

test("a model reply that breaks the loop is recorded as an error, and the bench goes on", async () => {
  const r = makeRepo();
  const d = deps(r, []);
  d.runLoop = async (prompt, policy, opts) => {
    opts.onRound(1, opts.maxRounds);
    await policy.executeTool("self_work__read", { path: "node-bot/util.js" });
    await assert.rejects(policy.executeTool("self_work__read", { path: "node-bot/missing.js" }));
    throw new Error("llama-server reply failed (500): Failed to parse tool call arguments as JSON");
  };
  const result = await runCase(r.c, d);

  assert.equal(result.ended, "error");
  assert.deepEqual([result.rounds, result.toolCalls, result.toolErrors], [1, 2, 1]);
  assert.match(result.error, /Failed to parse tool call/);
  assert.equal(result.passed, false);
  assert.equal(fs.existsSync(path.join(r.worktrees, "bench-1-add-subtracts")), false);
});

test("verify: the hidden test fails at the base and passes with the fix's files", () => {
  const r = makeRepo();
  const v = verifyCase(r.c, { repoRoot: r.repo, worktreesDir: r.worktrees });
  assert.deepEqual(v, { id: r.c.id, ok: true, failsAtBase: true, passesWithFix: true, tail: "" });
});

test("the report has a row per case and each case's diff", async () => {
  const r = makeRepo();
  const out = path.join(r.repo, "..", "report");
  const result = await runCase(r.c, deps(r, [edit("node-bot/util.js", "a - b", "a + b"), finish]));
  const md = writeReport([result], out, { model: "fake.gguf" });

  assert.match(md, /Model: fake\.gguf\. 1 cases x 1 repeat\(s\)\./);
  assert.match(md, /\*\*pass@1 100%, pass@1 100%\*\*/);
  assert.match(md, /\| 1-add-subtracts \| - \| 1 \| pass \| finished \| - \| 2 \| 2 \(0\) \| \d+s \| 200 \/ 20 \/ 200 \| 0 \|/);
  const json = JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8"));
  assert.equal(json.results[0].patch, undefined);
  assert.match(fs.readFileSync(path.join(out, "1-add-subtracts.diff"), "utf8"), /a \+ b/);
});

// #1221
test("a live case's hidden tests come from its own folder, and verify only needs them to fail at the base", () => {
  const r = makeRepo();
  const hiddenFrom = path.join(r.repo, "..", "hidden");
  fs.mkdirSync(path.join(hiddenFrom, "node-bot", "test"), { recursive: true });
  fs.writeFileSync(
    path.join(hiddenFrom, "node-bot", "test", "util.test.js"),
    'const test = require("node:test");\nconst assert = require("node:assert");\ntest("adds", () => assert.equal(require("../util").add(1, 1), 2));\n',
  );
  const live = { ...r.c, id: "2-live", fix: null, hiddenFrom };
  assert.deepEqual(verifyCase(live, { repoRoot: r.repo, worktreesDir: r.worktrees }).ok, true);
});

test("pass@1 is the mean over repeats, pass@k any repeat, the spread the fewest and most passes", () => {
  const run = (id, kind, repeat, passed) => ({ id, kind, repeat, passed, wallMs: 1000, rounds: 5, toolCalls: 5, tokens: { prompt: 10, completion: 1, peak: 10 } });
  const s = summarize([
    run("a", "node-bug", 1, true), run("b", "launcher", 1, false),
    run("a", "node-bug", 2, false), run("b", "launcher", 2, false),
    run("a", "node-bug", 3, true), run("b", "launcher", 3, true),
  ]);
  assert.equal(s.overall.pass1, 0.5);
  assert.equal(s.overall.passK, 1);
  assert.deepEqual(s.overall.spread, [0, 2]);
  assert.equal(s.byKind["node-bug"].pass1, 2 / 3);
  assert.equal(s.byKind.launcher.passK, 1);
});

test("each failed run gets one failure kind", () => {
  const c = { fixFiles: ["node-bot/util.js", "docs/x.md"] };
  const base = { passed: false, ended: "not-finished", summary: "", rounds: 5, maxRounds: 20, editErrors: 0, contextSize: 16384, outside: [], tokens: { peak: 5000, textCalls: 0 }, diff: { files: [] } };
  const kind = (over) => failureKind({ ...base, ...over }, c);
  assert.equal(kind({ passed: true }), null);
  assert.equal(kind({ tokens: { peak: 13000, textCalls: 0 } }), "context overflow");
  assert.equal(kind({ ended: "stuck" }), "stuck");
  assert.equal(kind({ ended: "refuted" }), "no valid edit: reviewer refusal");
  assert.equal(kind({ ended: "error", error: "llama-server reply failed (500): Failed to parse tool call arguments" }), "no valid edit: parse failure");
  assert.equal(kind({ editErrors: 2 }), "no valid edit: bad arguments");
  assert.equal(kind({ tokens: { peak: 5000, textCalls: 1 } }), "no valid edit: parse failure");
  assert.equal(kind({ rounds: 20 }), "out of rounds");
  assert.equal(kind({ rounds: 20, tokens: { peak: 5000, textCalls: 1 } }), "out of rounds", "a call in the forced final answer");
  assert.equal(kind({}), "no valid edit");
  assert.equal(kind({ diff: { files: ["node-bot/other.js"] }, outside: ["node-bot/other.js"] }), "wrong file");
  assert.equal(kind({ diff: { files: ["node-bot/util.js", "node-bot/x.js"] }, outside: ["node-bot/x.js"] }), "scope creep");
  assert.equal(kind({ diff: { files: ["node-bot/util.js"] } }), "tests fail");
});
