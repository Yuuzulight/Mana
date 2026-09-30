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
  // No trailing slash, like the repo's own: the worktree's node_modules is a
  // link (a symlink off Windows), which "node_modules/" doesn't match.
  fs.writeFileSync(path.join(live, ".gitignore"), "node_modules\n");
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
function fakeExec(ghCalls, { labels = [], prs = [], issues = [], author = "Yuuzulight", login = "Yuuzulight" } = {}) {
  const { execFile } = require("node:child_process");
  return (cmd, args, { cwd }) =>
    new Promise((resolve) => {
      if (cmd === "gh") {
        ghCalls.push(args);
        if (args[0] === "api" && args[1] === "user" && !login) return resolve({ code: 1, stdout: "", stderr: "not logged in" });
        const out = args[0] === "issue" && args[1] === "view"
          ? JSON.stringify({ number: 7, title: "Fix the add helper", body: "add() subtracts.", state: "OPEN", labels, author: { login: author } })
          : args[0] === "pr" && args[1] === "create"
            ? "https://github.com/x/y/pull/8\n"
            : args[0] === "api" && args[1] === "user"
              ? `${login}\n`
            : args[0] === "pr" && args[1] === "list"
              ? JSON.stringify(prs)
              : args[0] === "issue" && args[1] === "list"
                ? JSON.stringify(issues.map((number) => ({ number })))
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
    opts.onRound?.(1, opts.maxRounds);
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

function selfWork(repos, { calls, answer = "I made add() add and tested it.\nCo-Authored-By: Someone <x@y>", passed = true, review = null, labels, seen, onTest = () => {}, prs, issues, author, login, ...extra } = {}) {
  const ghCalls = [];
  const testRuns = [];
  const sw = createSelfWork({
    repoRoot: repos.live,
    worktreesDir: repos.worktrees,
    exec: fakeExec(ghCalls, { labels, prs, issues, author, login }),
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
    ramPercent: () => 50,
    ...extra,
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
  // #1124: the round she's on, for the Background tasks panel.
  assert.equal(status.round, 1);
  assert.equal(status.maxRounds, 20);
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
  assert.ok(!ghCalls.some((a) => a[0] === "pr" && a[1] === "create"));
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
  assert.ok(!ghCalls.some((a) => a[0] === "pr" && a[1] === "create"));
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
  assert.ok(!ghCalls.some((a) => a[0] === "pr" && a[1] === "create"));
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
  const fake = { start: async (n, opts) => (started.push([n, opts]), { ok: true }), stop: () => true, status: () => ({ state: "idle" }) };
  await withServer(createApp({ selfWork: fake }), async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/self-work`)).status, 401);
    const post = (route, body) =>
      fetchAsAdmin(`${baseUrl}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await fetch(`${baseUrl}/self-work/start`, { method: "POST" })).status, 401);
    assert.deepEqual(await (await post("/self-work/start", { issue: 7 })).json(), { ok: true });
    await post("/self-work/start", { issue: 8, allowGuardrails: true });
    await post("/self-work/start", { issue: 9, allowGuardrails: "yes" });
    assert.deepEqual(await (await post("/self-work/stop", {})).json(), { stopped: true });
    assert.deepEqual(await (await fetchAsAdmin(`${baseUrl}/self-work`)).json(), { state: "idle" });
  });
  assert.deepEqual(started, [
    [7, { allowGuardrails: false }],
    [8, { allowGuardrails: true }],
    [9, { allowGuardrails: false }],
  ]);
});

// #1007: budget and gating.
const read = ["self_work__read", { path: "node-bot/util.js" }];

test("she pauses while 2 of her PRs wait for review; other PRs don't count", async () => {
  const repos = makeRepos();
  const mine = [{ number: 20, headRefName: "mana/5-a" }, { number: 21, headRefName: "mana/6-b" }];
  const full = selfWork(repos, { calls: [fix], prs: [...mine, { number: 22, headRefName: "feat/x" }] });
  const refused = await full.sw.start(7);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /2 of my PRs are waiting for your review \(#20, #21\)/);
  const one = selfWork(repos, { calls: [], prs: [mine[0], { number: 22, headRefName: "feat/x" }] });
  assert.equal((await one.sw.start(7)).ok, true);
  await one.sw._current().done;
});

test("no start in a game or above 85% RAM, and a game that starts mid-run pauses her", async () => {
  const repos = makeRepos();
  assert.match((await selfWork(repos, { calls: [], isGaming: () => true }).sw.start(7)).error, /game is running/);
  assert.match((await selfWork(repos, { calls: [], ramPercent: () => 91 }).sw.start(7)).error, /RAM is at 91%/);

  const game = { on: false };
  const { sw, ghCalls } = selfWork(repos, { calls: [fix, () => (game.on = true), runTests, finish], isGaming: () => game.on });
  await sw.start(7);
  await sw._current().done;
  assert.equal(sw.status().state, "paused");
  assert.match(sw.status().step, /A game started/);
  assert.ok(!ghCalls.some((a) => a[0] === "pr" && a[1] === "create"));
});

test("a RAM spike holds her test run until it passes, and pauses her if it doesn't", async () => {
  const repos = makeRepos();
  const readings = [50, 90, 90, 60]; // the start check, then the test run's
  const sleeps = [];
  const waited = selfWork(repos, {
    calls: [fix, runTests, finish],
    ramPercent: () => readings.shift() ?? 60,
    sleep: async (ms) => sleeps.push(ms),
  });
  await waited.sw.start(7);
  await waited.sw._current().done;
  assert.equal(waited.sw.status().state, "pr-open");
  assert.deepEqual(sleeps, [60000, 60000]);

  const repos2 = makeRepos();
  let ram = 50;
  const stuck = selfWork(repos2, {
    calls: [fix, () => (ram = 95), runTests, finish],
    ramPercent: () => ram,
    sleep: async () => {},
  });
  await stuck.sw.start(7);
  await stuck.sw._current().done;
  assert.equal(stuck.sw.status().state, "paused");
  assert.match(stuck.sw.status().step, /RAM stayed above 85%/);
});

test("a run going nowhere stops after 8 steps without anything new", async () => {
  const repos = makeRepos();
  const seen = [];
  const { sw } = selfWork(repos, { calls: [read, ...Array(9).fill(read), fix], seen });
  await sw.start(7);
  await sw._current().done;
  assert.equal(sw.status().state, "stuck");
  const results = seen.filter((s) => s.name).map((s) => s.result || s.error);
  assert.doesNotMatch(results[8], /blocked/); // the first read plus 8 repeats run
  assert.match(results[9], /"blocked"/);
  assert.match(results[10], /"blocked"/); // her fix isn't written once she's stuck
  assert.match(fs.readFileSync(path.join(sw.status().worktree, "node-bot", "util.js"), "utf8"), /a - b/);
});

test("starting on her own: the oldest labelled issue without her PR, or nothing", async () => {
  const repos = makeRepos();
  const none = selfWork(repos, { calls: [], issues: [3], prs: [{ number: 30, headRefName: "mana/3-old" }] });
  assert.match((await none.sw.startIdle()).error, /No issue is waiting for me/);

  const on = selfWork(repos, {
    calls: [],
    issues: [9, 3, 7],
    prs: [{ number: 30, headRefName: "mana/3-old" }],
    labels: [{ name: "mana-task" }],
  });
  assert.equal((await on.sw.startIdle()).ok, true);
  assert.equal(on.sw.status().issue, 7);
  await on.sw._current().done;
});

test("20 minutes idle tries an idle start once per idle period", async () => {
  const { createApp } = require("../server");
  const { withServer, useTestAdminToken } = require("./helpers");
  const fetch = useTestAdminToken();
  let idleStarts = 0;
  const fake = { startIdle: async () => (idleStarts++, { ok: false }), status: () => ({ state: "idle" }) };
  const app = createApp({
    selfWork: fake,
    getGamingStatus: () => ({ gamingAppRunning: false }),
    triggerIdleConsolidation: async () => {},
  });
  await withServer(app, async (baseUrl) => {
    const report = (idleSeconds) =>
      fetch(`${baseUrl}/internal/idle-report`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idleSeconds }) });
    await report(60);
    await report(1300);
    await report(1400);
    assert.equal(idleStarts, 1);
    await report(10);
    await report(1300);
    assert.equal(idleStarts, 2);
  });
});

// #1008: the chat's "work on #N", and what reaches the chat.
test("chat: only a number from my message, and only my issue or a labelled one", async () => {
  const repos = makeRepos();
  const call = (sw, message, issue) => sw.chatToolSource(message).executeTool("self_work__start", { issue }).then(JSON.parse);

  const stranger = selfWork(repos, { calls: [], author: "someone-else" });
  assert.match((await call(stranger.sw, "work on #7 please", 8)).error, /#8 isn't in their message/);
  assert.match((await call(stranger.sw, "work on #7 please", 7)).error, /isn't one of yours and has no mana-task label/);
  assert.ok(!stranger.ghCalls.some((a) => a[0] === "issue" && a[1] === "edit"));

  const labelled = selfWork(repos, { calls: [], author: "someone-else", labels: [{ name: "mana-task" }] });
  assert.equal((await call(labelled.sw, "work on #7", 7)).status, "ok");
  await labelled.sw._current().done;

  const mine = selfWork(repos, { calls: [] });
  const started = await call(mine.sw, "can you take #7?", 7);
  assert.equal(started.status, "ok");
  assert.equal(started.branch, "mana/7-fix-the-add-helper");
  assert.ok(mine.ghCalls.some((a) => a.join(" ") === "issue edit 7 --add-label mana-task"));
  await mine.sw._current().done;
});

test("starts and ends are notices; the steps between aren't", async () => {
  const repos = makeRepos();
  const events = [];
  const { sw } = selfWork(repos, { calls: [fix, runTests, finish], onEvent: (run, text, notice) => events.push({ text, notice }) });
  await sw.start(7);
  await sw._current().done;
  const notices = events.filter((e) => e.notice).map((e) => e.text);
  assert.equal(notices.length, 2);
  assert.match(notices[0], /^I'm starting on #7: Fix the add helper/);
  assert.match(notices[1], /^My PR for #7 is ready: https:\/\/github.com\/x\/y\/pull\/8/);
  assert.ok(events.some((e) => !e.notice && /Changed node-bot\/util\.js/.test(e.text)));
});

// #1009: guardrail changes only through a run I flag, as a labelled draft.
const loosenGuard = ["coding__propose_edit", { path: "node-bot/approval-gate.js", old_text: "// guard", new_text: "// guard, reworded" }];

test("a normal run is refused a guardrail write, carries on, and says how to allow it", async () => {
  const repos = makeRepos();
  const events = [];
  const { sw, ghCalls } = selfWork(repos, {
    calls: [loosenGuard, fix, runTests, finish],
    onEvent: (run, text, notice) => notice && events.push(text),
  });
  await sw.start(7);
  await sw._current().done;
  assert.equal(sw.status().state, "pr-open");
  const create = ghCalls.find((a) => a[0] === "pr" && a[1] === "create");
  assert.ok(!create.includes("--draft"));
  assert.ok(!ghCalls.some((a) => a.includes("mana-guardrail")));
  assert.match(events.at(-1), /needed to change my guardrails \(node-bot\/approval-gate\.js\).*Allow guardrail changes/);
  assert.equal(git(path.join(repos.worktrees, "mana-7"), "show", "HEAD:node-bot/approval-gate.js"), "// guard");
});

test("a run I flag may change a guardrail; its PR is a labelled draft that lists it", async () => {
  const repos = makeRepos();
  const seen = [];
  const { sw, ghCalls } = selfWork(repos, { calls: [loosenGuard, runTests, finish], seen });
  await sw.start(7, { allowGuardrails: true });
  await sw._current().done;
  assert.equal(sw.status().state, "pr-open");
  assert.match(seen[0].prompt, /flagged this run to allow changes to your guardrails/);
  assert.match(git(repos.origin, "show", "mana/7-fix-the-add-helper:node-bot/approval-gate.js"), /reworded/);
  const create = ghCalls.find((a) => a[0] === "pr" && a[1] === "create");
  assert.equal(create[create.indexOf("--title") + 1], "[Guardrail] Fix the add helper");
  assert.ok(create.includes("--draft"));
  assert.match(create[create.indexOf("--body") + 1], /## Guardrail changes[\s\S]*- `node-bot\/approval-gate\.js`/);
  assert.ok(ghCalls.some((a) => a.join(" ") === "pr edit mana/7-fix-the-add-helper --add-label mana-guardrail"));
});

test("only I can flag a run: the chat and idle starts can't", async () => {
  const repos = makeRepos();
  const { sw } = selfWork(repos, { calls: [loosenGuard], labels: [{ name: "mana-task" }] });
  await sw.start(7, { by: "chat", allowGuardrails: true });
  assert.equal(sw.status().flagged, false);
  await sw._current().done;
  assert.equal(sw.status().state, "no-change");
});

test("not even a flagged run writes or pushes CI files", async () => {
  const repos = makeRepos();
  const seen = [];
  const { sw, ghCalls } = selfWork(repos, {
    calls: [["coding__propose_edit", { path: ".github/workflows/ci.yml", new_text: "on: push\n" }], fix, runTests, finish],
    onTest: (cwd) => {
      fs.mkdirSync(path.join(cwd, "..", ".github"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "..", ".github", "x.yml"), "on: push\n");
    },
    seen,
  });
  await sw.start(7, { allowGuardrails: true });
  await sw._current().done;
  assert.match(seen.find((s) => s.name === "coding__propose_edit").error, /\.github\/workflows\/ci\.yml isn't mine to write/);
  assert.equal(sw.status().state, "needs-you");
  assert.match(sw.status().step, /\.github\/x\.yml, which I never push/);
  assert.ok(!ghCalls.some((a) => a[0] === "pr" && a[1] === "create"));
});

test("her prompts name the repo owner: my override, else my gh login (looked up once), else origin's owner", async () => {
  const repos = makeRepos();
  const userLookups = (ghCalls) => ghCalls.filter((a) => a[0] === "api" && a[1] === "user").length;

  const seen = [];
  const byLogin = selfWork(repos, { calls: [finish], seen, login: "octo" });
  await byLogin.sw.start(7, { allowGuardrails: true });
  await byLogin.sw._current().done;
  await byLogin.sw.start(7, { allowGuardrails: true });
  await byLogin.sw._current().done;
  assert.match(seen[0].prompt, /- octo flagged this run/);
  assert.equal(userLookups(byLogin.ghCalls), 1);

  const overridden = [];
  const byEnv = selfWork(repos, {
    calls: [finish],
    seen: overridden,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, MANA_SELF_WORK_OWNER: "Someone" },
  });
  await byEnv.sw.start(7, { allowGuardrails: true });
  await byEnv.sw._current().done;
  assert.match(overridden[0].prompt, /- Someone flagged this run/);
  assert.equal(userLookups(byEnv.ghCalls), 0);

  // No gh login: the chat check takes the owner from origin's URL (a
  // local path shaped like one, so nothing reaches the network).
  git(repos.live, "remote", "set-url", "origin", `${repos.base.replaceAll("\\", "/")}/RepoOwner/Mana.git`);
  const byRemote = selfWork(repos, { calls: [], author: "RepoOwner", login: null });
  await byRemote.sw.chatToolSource("work on #7").executeTool("self_work__start", { issue: 7 });
  await byRemote.sw._current().done;
  assert.ok(byRemote.ghCalls.some((a) => a[0] === "issue" && a[1] === "edit"), "RepoOwner's issue counts as mine");
});
