// #1406: when her own attempts fail, DeepSeek runs her loop, one tier at a
// time, from a clean worktree with the facts of her attempts; capped per
// issue and per day, held at peak price unless I say go ahead, metered,
// and never kept as training data.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const { createSelfWork } = require("../self-work");
const { createEscalation } = require("../self-work-escalation");
const { createApiSpending } = require("../api-spending");

// Wednesday 2026-10-07: 02:00 UTC is DeepSeek's peak, 12:00 UTC isn't.
const PEAK = new Date("2026-10-07T02:00:00Z");
const OFF = new Date("2026-10-07T12:00:00Z");
const ON = { enabled: true, baseUrl: "https://api.deepseek.test", apiKey: "sk-test" };

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mana-escalation-"));
const bases = [];
test.after(() => bases.forEach((b) => fs.rmSync(b, { recursive: true, force: true })));

function escalation({ settings = ON, env = {}, at = OFF, file } = {}) {
  let now = at;
  const e = createEscalation({ file: file || path.join(tmp(), "esc.json"), settings: () => settings, env, now: () => now });
  return { e, setNow: (d) => (now = d) };
}

test("unavailable: switched off, no key, or local-only", () => {
  assert.match(escalation({ settings: { ...ON, enabled: false } }).e.unavailable(), /switched off/);
  assert.match(escalation({ settings: { ...ON, apiKey: "" } }).e.unavailable(), /no DeepSeek key/);
  assert.match(escalation({ env: { MANA_LOCAL_ONLY: "1" } }).e.unavailable(), /local-only/);
  assert.equal(escalation().e.unavailable(), null);
});

test("one run per tier per issue until my retry; 5 a day; go ahead lets one through", () => {
  const { e } = escalation();
  const [flash, pro] = e.tiers;
  e.begin(7, flash);
  assert.deepEqual(e.tiersLeft(7).map((t) => t.id), ["pro"]);
  e.begin(7, pro);
  assert.deepEqual(e.tiersLeft(7), []);
  e.reset(7);
  assert.equal(e.tiersLeft(7).length, 2, "my retry gives the tiers back");
  // #7's two runs count toward the day too.
  for (const n of [8, 9]) e.begin(n, flash);
  assert.equal(e.gate(11).ok, true);
  e.begin(11, flash); // 5 runs today, 5 allowed
  const capped = e.gate(12);
  assert.equal(capped.kind, "day");
  assert.match(capped.why, /go ahead on #12/);
  e.goAhead(12);
  assert.equal(e.gate(12).ok, true);
  e.begin(12, flash);
  assert.equal(e.gate(12).ok, false, "the go ahead is used up");
});

test("peak price holds it with the facts until off-peak or my go ahead; it survives a restart", () => {
  const file = path.join(tmp(), "esc.json");
  const { e, setNow } = escalation({ at: PEAK, file });
  const g = e.gate(7);
  assert.equal(g.kind, "peak");
  assert.match(g.why, /half price from .+go ahead on #7/);
  e.hold(7, "Attempt 1: not finished", g.kind);
  assert.equal(e.waitingNow(7), true);
  const again = createEscalation({ file, settings: () => ON, env: {}, now: () => PEAK });
  assert.equal(again.held(7).facts, "Attempt 1: not finished");
  setNow(OFF);
  assert.equal(e.waitingNow(7), false, "off-peak: the idle picker may take it");
  again.goAhead(7);
  assert.equal(again.gate(7).ok, true);
});

// --- Through self-work, with a fake DeepSeek ---

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
}
const read = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

function makeRepos() {
  const base = tmp();
  bases.push(base);
  const origin = path.join(base, "origin.git");
  const live = path.join(base, "live");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  git(base, "clone", "-q", origin, live);
  git(live, "config", "user.name", "Test");
  git(live, "config", "user.email", "test@example.com");
  fs.mkdirSync(path.join(live, "node-bot", "test"), { recursive: true });
  fs.writeFileSync(path.join(live, "node-bot", "util.js"), "function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n");
  fs.writeFileSync(path.join(live, ".gitignore"), "node_modules\n");
  git(live, "add", "-A");
  git(live, "commit", "-q", "-m", "init");
  git(live, "push", "-q", "origin", "main");
  return { base, live, worktrees: path.join(base, "worktrees") };
}

function fakeExec(ghCalls) {
  const { execFile } = require("node:child_process");
  return (cmd, args, { cwd }) =>
    new Promise((resolve) => {
      if (cmd === "gh") {
        ghCalls.push(args);
        const out =
          args[0] === "issue" && args[1] === "view"
            ? JSON.stringify({ number: 7, title: "Fix the add helper", body: "add() subtracts.", state: "OPEN", labels: [{ name: "mana-task" }], author: { login: "Yuuzulight" } })
            : args[0] === "pr" && args[1] === "create"
              ? "https://github.com/x/y/pull/8\n"
              : args[0] === "api"
                ? "Yuuzulight\n"
                : args[0] === "pr" && args[1] === "list"
                  ? "[]"
                  : "";
        return resolve({ code: 0, stdout: out, stderr: "" });
      }
      execFile(cmd, args, { cwd, windowsHide: true }, (err, stdout, stderr) => resolve({ code: err ? err.code || 1 : 0, stdout: String(stdout), stderr: String(stderr) }));
    });
}

const FIXED = "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n";
const plan = ["self_work__plan", { steps: ["Make add() add", "Test it"], no_test: "scripted" }];
const fix = ["coding__propose_edit", { path: "node-bot/util.js", old_text: "return a - b;", new_text: "return a + b;" }];
const runTests = ["coding__run_tests", { path: "node-bot/test/util.test.js" }];
const reviews = ["correctness", "edge cases", "scope"].map((pass) => ["self_work__review", { pass }]);
const finish = ["session_goal__finish", { reason: "done" }];
const gotNowhere = [[], "Not done yet: I couldn't find it."];
const passes = [[plan, fix, runTests, ...reviews, finish], "I made add() add."];
const usage = { prompt_tokens: 1000, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200, completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 40 } };

async function play(policy, calls, seen) {
  for (const [name, args] of calls) {
    try {
      seen.push({ name, result: await policy.executeTool(name, args) });
    } catch (e) {
      seen.push({ name, error: e.message });
    }
  }
}

// local: her loop's scripts; remote: { model: script } for each tier.
function setup({ local = [gotNowhere], remote = {}, at = OFF, settings = ON, testsPass = () => true } = {}) {
  const repos = makeRepos();
  const ghCalls = [];
  const seen = [];
  const remoteCalls = [];
  const events = [];
  const saved = [];
  let i = 0;
  const runLoop = async (prompt, policy) => {
    const [calls, answer] = local[i++] || gotNowhere;
    seen.push({ who: "local", prompt });
    await play(policy, calls, seen);
    return { content: answer };
  };
  const remoteLoop = (config) => {
    remoteCalls.push({ model: config.model, thinking: config.thinking, apiKey: config.apiKey });
    return async (prompt, policy) => {
      const [calls, answer] = remote[config.model] || gotNowhere;
      seen.push({ who: config.model, prompt });
      config.onResponse({ usage, choices: [{ message: { reasoning_content: `${config.model} thinking it over` } }] });
      await play(policy, calls, seen);
      return { content: answer };
    };
  };
  const spending = createApiSpending({ file: path.join(repos.base, "spending.json"), now: () => at });
  const { e, setNow } = escalation({ at, settings, file: path.join(repos.base, "esc.json") });
  const sw = createSelfWork({
    repoRoot: repos.live,
    worktreesDir: repos.worktrees,
    exec: fakeExec(ghCalls),
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, MANA_SELF_WORK_ATTEMPTS: "1" },
    reviewEdit: async () => null,
    runLoop,
    escalation: e,
    remoteLoop,
    spending,
    traces: { enabled: () => true, save: (rec) => (saved.push(rec), { saved: true }), mark: () => {} },
    runTests: async () => {
      const ok = testsPass();
      return { exitCode: ok ? 0 : 1, timedOut: false, output: ok ? "ok" : "not ok 1 - add adds\n# fail 1" };
    },
    onEvent: (run, text, notice) => events.push({ text, notice }),
    ramPercent: () => 50,
  });
  const runIssue = async () => {
    assert.equal((await sw.start(7)).ok, true);
    await sw._current().done;
    return sw.status();
  };
  return { repos, sw, e, setNow, ghCalls, seen, remoteCalls, events, saved, spending, runIssue };
}

test("her attempt fails, Flash passes: the PR says so, it's metered, and it isn't a training record", async () => {
  const s = setup({ remote: { "deepseek-flash": passes } });
  const status = await s.runIssue();
  assert.equal(status.state, "pr-open", status.step);
  assert.deepEqual(s.remoteCalls, [{ model: "deepseek-flash", thinking: true, apiKey: "sk-test" }]);
  const flashPrompt = s.seen.find((x) => x.who === "deepseek-flash").prompt;
  assert.match(flashPrompt, /Earlier attempts at this issue didn't pass\. What they found:/);
  assert.equal(read(path.join(s.repos.worktrees, "mana-7", "node-bot", "util.js")), FIXED);
  const create = s.ghCalls.find((a) => a[0] === "pr" && a[1] === "create");
  assert.match(create[create.indexOf("--body") + 1], /came from DeepSeek Flash \(deepseek-flash\) running my self-work loop/);
  assert.deepEqual(s.saved, [], "a remote model's run is never training data");
  assert.equal(s.spending.summary().total.byUse["self-work"].cacheHit, 800);
  assert.match(status.step, /DeepSeek Flash: 1k in \(1k cached\), 0k out|DeepSeek Flash: 1k in/);
  assert.equal(fs.existsSync(path.join(s.repos.worktrees, "self-work-reasoning")), false, "a passing tier keeps no reasoning");
});

test("Flash fails, Pro passes: Pro hears what Flash tried, and Flash's reasoning is kept", async () => {
  let call = 0;
  // Her run is unjudged; Flash's tests fail; Pro's pass.
  const s = setup({
    remote: { "deepseek-flash": [[plan, fix, runTests, ...reviews, finish], "Done, I think."], "deepseek-v4-pro": passes },
    testsPass: () => ++call > 2,
  });
  const status = await s.runIssue();
  assert.equal(status.state, "pr-open", status.step);
  assert.deepEqual(s.remoteCalls.map((c) => c.model), ["deepseek-flash", "deepseek-v4-pro"]);
  assert.match(s.seen.find((x) => x.who === "deepseek-v4-pro").prompt, /DeepSeek Flash's try: /);
  const kept = fs.readdirSync(path.join(s.repos.worktrees, "self-work-reasoning"));
  assert.equal(kept.length, 1);
  assert.match(kept[0], /^7-flash-/);
  assert.match(fs.readFileSync(path.join(s.repos.worktrees, "self-work-reasoning", kept[0]), "utf8"), /deepseek-flash thinking it over/);
});

test("at peak it holds, then my go ahead runs DeepSeek straight away without her attempts again", async () => {
  const s = setup({ at: PEAK, remote: { "deepseek-flash": passes } });
  const first = await s.runIssue();
  assert.equal(first.state, "waiting", first.step);
  assert.match(first.step, /half price from/);
  assert.deepEqual(s.remoteCalls, []);
  assert.equal(s.e.waitingNow(7), true);
  const localRuns = s.seen.filter((x) => x.who === "local").length;
  s.e.goAhead(7);
  const second = await s.runIssue();
  assert.equal(second.state, "pr-open", second.step);
  assert.equal(s.seen.filter((x) => x.who === "local").length, localRuns, "no second round of her own attempts");
  assert.equal(s.e.held(7), null);
});

test("switched off: no remote call, and her run ends as it would have", async () => {
  const s = setup({ settings: { ...ON, enabled: false }, remote: { "deepseek-flash": passes } });
  const status = await s.runIssue();
  assert.notEqual(status.state, "pr-open");
  assert.deepEqual(s.remoteCalls, []);
});

// #1441: the models I pick in Settings, on any provider.
test("tiers: DeepSeek's two until I pick; another provider's are mine to pick, without DeepSeek's thinking switch", () => {
  const { tiersFor } = require("../self-work-escalation");
  assert.deepEqual(tiersFor({ preset: "deepseek" }).map((t) => t.id), ["flash", "pro"]);
  assert.deepEqual(tiersFor({ preset: "deepseek", models: ["deepseek-v4-pro"] }).map((t) => t.id), ["pro"]);
  assert.deepEqual(tiersFor({ preset: "openrouter" }), []);
  const [first, second] = tiersFor({ preset: "openrouter", models: ["qwen/qwen3-coder", "openai/gpt-5"] });
  assert.deepEqual([first.model, first.thinking, second.label], ["qwen/qwen3-coder", null, "openai/gpt-5"]);
});

test("another provider: its own key wording, a local one needs none, no models picked says so, and no peak hold", () => {
  const other = { enabled: true, preset: "openrouter", label: "OpenRouter", needsKey: true, models: ["qwen/qwen3-coder"], baseUrl: "https://openrouter.test", apiKey: "" };
  assert.match(escalation({ settings: other }).e.unavailable(), /no OpenRouter key/);
  assert.equal(escalation({ settings: { ...other, preset: "lmstudio", label: "LM Studio", needsKey: false } }).e.unavailable(), null);
  assert.match(escalation({ settings: { ...other, apiKey: "sk-or", models: [] } }).e.unavailable(), /no OpenRouter model is picked/);
  assert.equal(escalation({ settings: { ...other, apiKey: "sk-or" }, at: PEAK }).e.gate(7).ok, true);
});

test("finish and stats: per model, runs with an outcome, passes and cost", () => {
  const { e } = escalation();
  const [flash, pro] = e.tiers;
  e.begin(7, flash);
  e.finish(7, flash, { passed: false, usd: 0.04 });
  e.begin(7, pro);
  e.finish(7, pro, { passed: true, usd: 0.3 });
  e.begin(8, flash);
  e.finish(8, flash, { passed: true, usd: null });
  e.begin(9, flash); // still running: not counted
  assert.deepEqual(e.stats(), [
    { model: "deepseek-flash", runs: 2, passed: 1, usd: null },
    { model: "deepseek-v4-pro", runs: 1, passed: 1, usd: 0.3 },
  ]);
});
