// #1006: the self-work runner, against a throwaway origin and live clone.
// Real git, fake gh, a scripted loop instead of a model.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const { createSelfWork, findSecret, testEnv } = require("../self-work");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

const bases = [];
test.after(() => bases.forEach((b) => fs.rmSync(b, { recursive: true, force: true })));

// origin (bare) and a live clone with node-bot/ and a node_modules folder.
function makeRepos() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mana-self-work-"));
  bases.push(base);
  const origin = path.join(base, "origin.git");
  const live = path.join(base, "live");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  git(base, "clone", "-q", origin, live);
  git(live, "config", "user.name", "Test");
  git(live, "config", "user.email", "test@example.com");
  fs.mkdirSync(path.join(live, "node-bot", "test"), { recursive: true });
  fs.writeFileSync(path.join(live, "node-bot", "util.js"), "function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n");
  fs.writeFileSync(path.join(live, "node-bot", "approval-gate.js"), "// guard\n");
  fs.writeFileSync(path.join(live, ".gitignore"), "node_modules/\n");
  git(live, "add", "-A");
  git(live, "commit", "-q", "-m", "init");
  git(live, "push", "-q", "origin", "main");
  fs.mkdirSync(path.join(live, "node-bot", "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(live, "node-bot", "node_modules", "dep", "index.js"), "// live\n");
  return { base, origin, live, worktrees: path.join(base, "worktrees") };
}

const guard = {
  protectedPathFor: (full) => (/approval-gate\.js$/.test(full) ? "node-bot/approval-gate.js" : null),
  protectedPathMessage: (entry) => `${entry} is one of my guardrails`,
};

// Real git; gh answers from a script and records its calls.
function fakeExec(ghCalls, { labels = [] } = {}) {
  const { execFile } = require("node:child_process");
  return (cmd, args, { cwd }) =>
    new Promise((resolve) => {
      if (cmd === "gh") {
        ghCalls.push(args);
        const out = args[0] === "issue" && args[1] === "view"
          ? JSON.stringify({ number: 7, title: "Fix the add helper", body: "add() subtracts.", state: "OPEN", labels })
          : args[0] === "pr" && args[1] === "create"
            ? "https://github.com/x/y/pull/8\n"
            : "";
        return resolve({ code: 0, stdout: out, stderr: "" });
      }
      execFile(cmd, args, { cwd, windowsHide: true }, (err, stdout, stderr) =>
        resolve({ code: err ? err.code || 1 : 0, stdout: String(stdout), stderr: String(stderr) }),
      );
    });
}

// A loop that makes the given calls in order, then answers.
function scriptedLoop(calls, answer, seen = []) {
  return async (prompt, policy, opts) => {
    seen.push({ prompt, opts });
    for (const call of calls) {
      if (typeof call === "function") {
        call();
        continue;
      }
      const [name, args] = call;
      try {
        seen.push({ name, result: await policy.executeTool(name, args) });
      } catch (e) {
        seen.push({ name, error: e.message });
      }
    }
    return { content: answer };
  };
}

const fix = ["coding__propose_edit", { path: "node-bot/util.js", old_text: "return a - b;", new_text: "return a + b;", summary: "add adds" }];
const runTests = ["coding__run_tests", { path: "node-bot/test/util.test.js" }];
const finish = ["session_goal__finish", { reason: "fixed" }];

function selfWork(repos, { calls, answer = "I made add() add and tested it.\nCo-Authored-By: Someone <x@y>", passed = true, review = null, labels, seen, onTest = () => {} } = {}) {
  const ghCalls = [];
  const testRuns = [];
  const sw = createSelfWork({
    repoRoot: repos.live,
    worktreesDir: repos.worktrees,
    exec: fakeExec(ghCalls, { labels }),
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DISCORD_TOKEN: "super-secret-token-value" },
    protectedPaths: guard,
    reviewEdit: async () => review,
    runLoop: scriptedLoop(calls, answer, seen),
    runTests: async (command, cwd, opts) => {
      testRuns.push({ command, cwd, opts });
      onTest(cwd);
      return { exitCode: passed ? 0 : 1, timedOut: false, output: passed ? "ok" : "not ok" };
    },
    onEvent: () => {},
  });
  return { sw, ghCalls, testRuns };
}

test("an issue goes from worktree to a pushed branch and a PR, never main", async () => {
  const repos = makeRepos();
  const seen = [];
  const { sw, ghCalls, testRuns } = selfWork(repos, { calls: [fix, runTests, finish], seen });
  const started = await sw.start(7);
  assert.equal(started.ok, true);
  await sw._current().done;

  const status = sw.status();
  assert.equal(status.state, "pr-open", status.step);
  assert.equal(status.prUrl, "https://github.com/x/y/pull/8");
  const worktree = path.join(repos.worktrees, "mana-7");
  assert.equal(status.worktree, worktree);
  assert.equal(git(worktree, "rev-parse", "--abbrev-ref", "HEAD"), "mana/7-fix-the-add-helper");
  // Pushed as her branch; origin's main and the live checkout are untouched.
  assert.match(git(repos.origin, "show", "mana/7-fix-the-add-helper:node-bot/util.js"), /a \+ b/);
  assert.match(git(repos.origin, "show", "main:node-bot/util.js"), /a - b/);
  assert.match(fs.readFileSync(path.join(repos.live, "node-bot", "util.js"), "utf8"), /a - b/);
  // Not labelled yet, and I started it: she labels it.
  assert.ok(ghCalls.some((a) => a.join(" ") === "issue edit 7 --add-label mana-task"));
  const create = ghCalls.find((a) => a[0] === "pr" && a[1] === "create");
  assert.deepEqual(create.slice(2, 6), ["--base", "main", "--head", "mana/7-fix-the-add-helper"]);
  const body = create[create.indexOf("--body") + 1];
  assert.match(body, /^Closes #7\./);
  assert.doesNotMatch(body, /Co-Authored-By/i);
  assert.doesNotMatch(git(worktree, "log", "-1", "--format=%B"), /Co-Authored-By/i);
  assert.ok(!ghCalls.some((a) => a.includes("merge")), "she never merges");
  // Goal mode, capped at 20 rounds; tests ran in the worktree, without the backend's keys.
  assert.equal(seen[0].opts.maxRounds, 20);
  assert.match(seen[0].opts.goal, /^Implement issue #7/);
  assert.equal(testRuns[0].command, "node --test test/util.test.js");
  assert.equal(testRuns[0].cwd, path.join(worktree, "node-bot"));
  assert.ok(fs.lstatSync(path.join(worktree, "node-bot", "node_modules")).isSymbolicLink());
});

test("a refuted write isn't applied and the run stops to ask me", async () => {
  const repos = makeRepos();
  const { sw, ghCalls } = selfWork(repos, {
    calls: [fix, runTests, finish],
    review: { verdict: "refuted", failingCase: "add(1, 1) returns 3" },
  });
  await sw.start(7);
  await sw._current().done;
  const status = sw.status();
  assert.equal(status.state, "needs-you");
  assert.match(status.step, /add\(1, 1\) returns 3/);
  assert.match(fs.readFileSync(path.join(status.worktree, "node-bot", "util.js"), "utf8"), /a - b/);
  assert.ok(!ghCalls.some((a) => a[0] === "pr"));
});

test("writes stay inside her worktree and off her guardrails", async () => {
  const repos = makeRepos();
  const seen = [];
  const { sw } = selfWork(repos, {
    calls: [
      ["coding__propose_edit", { path: "node-bot/approval-gate.js", old_text: "// guard", new_text: "// gone" }],
      ["coding__propose_edit", { path: "node-bot/node_modules/dep/index.js", old_text: "// live", new_text: "// hacked" }],
      ["coding__propose_edit", { path: "../live/node-bot/util.js", old_text: "a - b", new_text: "a + b" }],
      ["coding__propose_edit", { path: "node-bot/.env", new_text: "X=1" }],
    ],
    labels: [{ name: "mana-task" }],
    seen,
  });
  await sw.start(7);
  await sw._current().done;
  const errors = seen.filter((s) => s.name).map((s) => s.error);
  assert.match(errors[0], /one of my guardrails/);
  assert.match(errors[1], /outside my worktree/);
  assert.match(errors[2], /escapes/);
  assert.match(errors[3], /credential/);
  assert.equal(fs.readFileSync(path.join(repos.live, "node-bot", "node_modules", "dep", "index.js"), "utf8"), "// live\n");
  assert.equal(sw.status().state, "no-change");
});

test("no PR while the tests fail after her last change", async () => {
  const repos = makeRepos();
  const { sw, ghCalls } = selfWork(repos, { calls: [fix, runTests, finish], passed: false });
  await sw.start(7);
  await sw._current().done;
  assert.equal(sw.status().state, "tests-failing");
  assert.ok(!ghCalls.some((a) => a[0] === "pr"));
});

test("Stop ends the run before her next step", async () => {
  const repos = makeRepos();
  const holder = {};
  const seen = [];
  const { sw } = selfWork(repos, { calls: [() => holder.sw.stop(), fix, finish], seen });
  holder.sw = sw;
  await sw.start(7);
  await sw._current().done;
  assert.equal(sw.status().state, "stopped");
  assert.match(seen.find((s) => s.name === "coding__propose_edit").result, /"blocked"/);
  assert.match(fs.readFileSync(path.join(sw.status().worktree, "node-bot", "util.js"), "utf8"), /a - b/);
});

test("a guardrail changed by anything in the run (her tests too) isn't pushed", async () => {
  const repos = makeRepos();
  const { sw, ghCalls } = selfWork(repos, {
    calls: [fix, runTests, finish],
    onTest: (cwd) => fs.writeFileSync(path.join(cwd, "approval-gate.js"), "// loosened\n"),
  });
  await sw.start(7);
  await sw._current().done;
  assert.equal(sw.status().state, "needs-you");
  assert.match(sw.status().step, /node-bot\/approval-gate\.js/);
  assert.ok(!ghCalls.some((a) => a[0] === "pr"));
  assert.throws(() => git(repos.origin, "rev-parse", "--verify", "mana/7-fix-the-add-helper"));
});

test("secrets: key shapes and the backend's own values are caught; her tests get a clean env", () => {
  const env = { DISCORD_TOKEN: "abcdefghijklmnop", PATH: "p" };
  assert.equal(findSecret("+const x = 'abcdefghijklmnop';", env), "the value of DISCORD_TOKEN");
  assert.equal(findSecret(`+t = "ghp_${"a".repeat(36)}"`, env), "a key-shaped string");
  assert.equal(findSecret("-removed abcdefghijklmnop\n+const token = makeToken();", env), null);
  const clean = testEnv({ Path: "p", DISCORD_TOKEN: "t", MANA_ADMIN_SECRET: "s" });
  assert.deepEqual(Object.keys(clean).sort(), ["DOTNET_CLI_TELEMETRY_OPTOUT", "NODE_ENV", "Path"]);
});

test("the routes need my admin key and reach the runner", async () => {
  const { createApp } = require("../server");
  const { withServer, useTestAdminToken } = require("./helpers");
  const fetchAsAdmin = useTestAdminToken();
  const started = [];
  const fake = { start: async (n) => (started.push(n), { ok: true }), stop: () => true, status: () => ({ state: "idle" }) };
  await withServer(createApp({ selfWork: fake }), async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/self-work`)).status, 401);
    const post = (route, body) =>
      fetchAsAdmin(`${baseUrl}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await fetch(`${baseUrl}/self-work/start`, { method: "POST" })).status, 401);
    assert.deepEqual(await (await post("/self-work/start", { issue: 7 })).json(), { ok: true });
    assert.deepEqual(await (await post("/self-work/stop", {})).json(), { stopped: true });
    assert.deepEqual(await (await fetchAsAdmin(`${baseUrl}/self-work`)).json(), { state: "idle" });
  });
  assert.deepEqual(started, [7]);
});
