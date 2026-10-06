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
// #1213: and reviews her diff in three passes before she finishes.
const reviews = ["correctness", "edge cases", "scope"].map((pass) => ["self_work__review", { pass }]);
// #1211/#1212: she writes a short plan before her first edit; these cases test the runner, not test-first, so the plan says why.
const plan = ["self_work__plan", { steps: ["fix add()", "finish"], no_test: "the bench case has its own hidden test" }];

function deps(r, calls) {
  const tokens = { prompt: 0, completion: 0, peak: 0, textCalls: 0 };
  // These fixtures exercise scoring on trusted synthetic code, not native approval/isolation.
  return { repoRoot: r.repo, worktreesDir: r.worktrees, runLoop: fakeModel(calls, tokens), runTests: require('../ai/coding-tool-source').runTestCommand, tokens, ramPercent: () => 50, onEvent: () => {}, sample: async () => ({ vramMb: 9000, ramPercent: 80 }) };
}

test('Windows benchmark refuses to run model work without its human test-approval gate', { skip: process.platform !== 'win32' }, async () => {
  const r = makeRepo();
  let called = false;
  const runner = require('../self-work').createSelfWork({ repoRoot: r.repo, runLoop: async () => { called = true; } });
  const result = await runner.bench({ number: 1, title: 'Fixture', body: '' }, r.repo);
  assert.match(result.error, /human approval gate/);
  assert.equal(called, false);
});

test("a case that fixes the bug passes its hidden test, and the worktree is gone after", async () => {
  const r = makeRepo();
  const result = await runCase(r.c, deps(r, [plan, edit("node-bot/util.js", "a - b", "a + b"), ...reviews, finish]));

  assert.equal(result.passed, true, result.hiddenTail);
  assert.equal(result.ended, "finished");
  assert.equal(result.rounds, 6);
  assert.equal(result.toolCalls, 6);
  assert.equal(result.toolErrors, 0);
  assert.deepEqual([result.peakVramMb, result.peakRamPercent, result.failure], [9000, 80, null]);
  assert.deepEqual(result.tokens, { prompt: 600, completion: 60, peak: 600, textCalls: 0, tps: null });
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

// #1269: --gemini runs only her Gemini fallback on the case, under her write rules.
test("the Gemini config scores Gemini CLI's own change, and a change outside her write rules is refused", async () => {
  const r = makeRepo();
  const gemini = (writes) => ({
    model: "fake",
    run: async ({ worktree, prompt }) => {
      assert.match(prompt, /add\(2, 3\) gives -1\./);
      for (const [rel, text] of Object.entries(writes)) {
        fs.mkdirSync(path.dirname(path.join(worktree, rel)), { recursive: true });
        fs.writeFileSync(path.join(worktree, rel), text);
      }
      return { outcome: "ok", ms: 5, response: "Fixed add()." };
    },
  });
  const fixed = "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n";
  const ok = await runCase(r.c, { ...deps(r, []), gemini: gemini({ "node-bot/util.js": fixed }) });
  assert.equal(ok.passed, true, ok.hiddenTail);
  assert.equal(ok.ended, "ok");
  assert.equal(ok.toolCalls, 0);
  assert.deepEqual(ok.diff.files, ["node-bot/util.js"]);

  const refused = await runCase(r.c, { ...deps(r, []), gemini: gemini({ "node-bot/util.js": fixed, ".github/workflows/x.yml": "on: push\n" }) });
  assert.equal(refused.ended, "refused");
  assert.equal(refused.failure, "refused: outside her write rules");
  assert.equal(refused.passed, false);
  assert.deepEqual(refused.diff.files, []);
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
  const result = await runCase(r.c, deps(r, [plan, edit("node-bot/util.js", "a - b", "a + b"), ...reviews, finish]));
  const md = writeReport([result], out, { model: "fake.gguf" });

  assert.match(md, /Model: fake\.gguf\. 1 cases x 1 repeat\(s\)\./);
  assert.match(md, /\*\*pass@1 100%, pass@1 100%\*\*/);
  assert.match(md, /\| 1-add-subtracts \| - \| 1 \| pass \| finished \| - \| 6 \| 6 \(0\) \| \d+s \| 600 \/ 60 \/ 600 \| 0 \|/);
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

test("a fixed case with its own hidden folder uses those tests, not the fix's", () => {
  const r = makeRepo();
  const hiddenFrom = path.join(r.repo, "..", "hidden");
  fs.mkdirSync(path.join(hiddenFrom, "node-bot", "test"), { recursive: true });
  // Fails even with the fix, so only these tests can make verify fail.
  fs.writeFileSync(
    path.join(hiddenFrom, "node-bot", "test", "util.test.js"),
    'const test = require("node:test");\nconst assert = require("node:assert");\ntest("adds", () => assert.equal(require("../util").add(1, 1), 3));\n',
  );
  const v = verifyCase({ ...r.c, id: "3-fixed-hidden", hiddenFrom }, { repoRoot: r.repo, worktreesDir: r.worktrees });
  assert.equal(v.failsAtBase, true);
  assert.equal(v.passesWithFix, false);
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

// #1249: a case's id and hidden tests stay inside the repo.
test("case files with an id or hidden test that climbs out or is absolute are refused", () => {
  const { loadCases } = require("../bench/self-work-bench");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-bench-cases-"));
  bases.push(dir);
  const write = (c) => {
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
    fs.writeFileSync(path.join(dir, "case.json"), JSON.stringify({ id: "1-ok", hiddenTests: ["node-bot/test/util.test.js"], ...c }));
  };
  write({});
  assert.equal(loadCases(dir)[0].id, "1-ok");
  for (const bad of [{ id: "../evil" }, { id: "a/b" }, { id: "x..y" }]) {
    write(bad);
    assert.throws(() => loadCases(dir), /bad case id/);
  }
  for (const hidden of ["../outside.test.js", "node-bot/../../x.js", "/etc/passwd", "C:\\Windows\\x.js", "node-bot\\..\\..\\x.js"]) {
    write({ hiddenTests: [hidden] });
    assert.throws(() => loadCases(dir), /must be a relative path inside the repo/, hidden);
  }
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
  const fixIt = fakeModel([plan, edit("node-bot/util.js", "a - b", "a + b"), ...reviews, finish], d.tokens);
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

test("#1278: a pause unloads the bench's model, and it's loaded again once the game ends", async () => {
  const { waitOut } = require("../bench/self-work-bench");
  const calls = [];
  const model = { stop: async () => calls.push("stop"), start: async () => calls.push("start") };
  const c = { id: "1-add-subtracts" };
  const gate = (gaming) => ({ isGaming: () => gaming.shift() ?? false, ramPercent: () => 50, backendModelUp: async () => false });
  const sleep = async () => calls.push("sleep");

  assert.equal(await waitOut(c, gate([false]), model, sleep), null);
  assert.deepEqual(calls, [], "no pause: the model stays loaded");

  assert.equal(await waitOut(c, gate([true, true, false]), model, sleep), null);
  assert.deepEqual(calls, ["stop", "sleep", "sleep", "start"]);

  calls.length = 0;
  const why = await waitOut(c, gate(Array(30).fill(true)), model, sleep);
  assert.equal(why, "a game is running");
  assert.deepEqual(calls, ["stop", ...Array(20).fill("sleep")], "never cleared: stays unloaded, the run stops");
});

test("a llama-server killed while loading stops the wait at once", async () => {
  const { waitUp } = require("../bench/self-work-bench");
  const { EventEmitter } = require("node:events");
  const server = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  let sleeps = 0;
  const sleep = async () => {
    sleeps += 1;
    Object.assign(server, { signalCode: "SIGTERM" }); // the RAM watchdog's kill
  };
  await assert.rejects(waitUp(server, async () => false, sleep), /exited \(SIGTERM\)/);
  assert.equal(sleeps, 1);
});
