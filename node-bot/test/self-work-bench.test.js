// #1203: the self-work benchmark runner, on a throwaway repo with a fake
// model. Real git, real hidden test run.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const { runCase, verifyCase, writeReport } = require("../bench/self-work-bench");

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
// #1211: she writes a short plan before her first edit.
const plan = ["self_work__plan", { steps: ["fix add()", "finish"] }];

function deps(r, calls) {
  const tokens = { prompt: 0, completion: 0, peak: 0, textCalls: 0 };
  return { repoRoot: r.repo, worktreesDir: r.worktrees, runLoop: fakeModel(calls, tokens), tokens, ramPercent: () => 50, onEvent: () => {} };
}

test("a case that fixes the bug passes its hidden test, and the worktree is gone after", async () => {
  const r = makeRepo();
  const result = await runCase(r.c, deps(r, [plan, edit("node-bot/util.js", "a - b", "a + b"), finish]));

  assert.equal(result.passed, true, result.hiddenTail);
  assert.equal(result.ended, "finished");
  assert.equal(result.rounds, 3);
  assert.equal(result.toolCalls, 3);
  assert.equal(result.toolErrors, 0);
  assert.deepEqual(result.tokens, { prompt: 300, completion: 30, peak: 300, textCalls: 0 });
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
    deps(r, [plan, edit("node-bot/util.js", "a - b", "a * b"), edit("node-bot/extra.js", "", "module.exports = 1;\n")]),
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
  const result = await runCase(r.c, deps(r, [plan, edit("node-bot/util.js", "a - b", "a + b"), finish]));
  const md = writeReport([result], out, { model: "fake.gguf" });

  assert.match(md, /1\/1 hidden tests passing\. Model: fake\.gguf\./);
  assert.match(md, /\| 1-add-subtracts \| pass \| finished \| 3 \| 3 \(0\) \| \d+s \| 300 \/ 30 \/ 300 \| 0 \|/);
  const json = JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8"));
  assert.equal(json.results[0].patch, undefined);
  assert.match(fs.readFileSync(path.join(out, "1-add-subtracts.diff"), "utf8"), /a \+ b/);
});

// #1231: a generated case is a bug patched into the base, with the test that
// catches it out of the tree until she's done.
function generatedCase(r) {
  const file = path.join(r.repo, "node-bot", "util.js");
  const good = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, good.replace("a + b", "a - b"));
  const mutation = `${git(r.repo, "diff", "--", "node-bot/util.js")}\n`;
  git(r.repo, "checkout", "--", "node-bot/util.js");
  return { ...r.c, id: "gen-add", base: r.c.fix, mutation };
}

test("a generated case: the bug is patched in, its test hidden, and her diff is only her fix", async () => {
  const r = makeRepo();
  const c = generatedCase(r);
  const d = deps(r, []);
  const fixIt = fakeModel([edit("node-bot/util.js", "a - b", "a + b"), finish], d.tokens);
  d.runLoop = async (prompt, policy, opts) => {
    await assert.rejects(policy.executeTool("self_work__read", { path: "node-bot/test/util.test.js" }));
    return fixIt(prompt, policy, opts);
  };
  const result = await runCase(c, d);

  assert.equal(result.passed, true, result.hiddenTail);
  assert.deepEqual(result.diff, { files: ["node-bot/util.js"], added: 1, removed: 1 });
  assert.match(result.patch, /-  return a - b;\n\+  return a \+ b;/);
  assert.deepEqual(verifyCase(c, { repoRoot: r.repo, worktreesDir: r.worktrees }), { id: c.id, ok: true, failsAtBase: true, passesWithFix: true, tail: "" });
});

test("a generated case's bug is committed: a reset to HEAD keeps it, and its test stays hidden", async () => {
  const r = makeRepo();
  const c = generatedCase(r);
  const wt = path.join(r.worktrees, `bench-${c.id}`);
  const d = deps(r, []);
  d.runLoop = async () => {
    git(wt, "reset", "-q", "--hard", "HEAD");
    git(wt, "clean", "-fdq", "-e", "node_modules");
    assert.match(fs.readFileSync(path.join(wt, "node-bot", "util.js"), "utf8"), /a - b/);
    assert.equal(fs.existsSync(path.join(wt, "node-bot", "test", "util.test.js")), false);
    return { content: "Not done yet." };
  };
  const result = await runCase(c, d);
  assert.deepEqual(result.diff.files, []);
  assert.equal(result.passed, false);
});

test("a mutation that doesn't apply leaves no worktree behind", async () => {
  const r = makeRepo();
  const c = { ...generatedCase(r), mutation: "not a patch\n" };
  await assert.rejects(runCase(c, deps(r, [])));
  assert.equal(fs.existsSync(path.join(r.worktrees, `bench-${c.id}`)), false);
  assert.doesNotMatch(git(r.repo, "worktree", "list"), /bench-gen-add/);
});
