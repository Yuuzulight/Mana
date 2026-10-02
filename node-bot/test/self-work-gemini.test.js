// #1269: Gemini CLI as self-work's cloud fallback, with a fake gemini (a
// node script) against a throwaway origin and live clone. Real git, fake
// gh, scripted loops instead of a model.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const { createSelfWork } = require("../self-work");
const { createGeminiFallback, TOOLS, INSTALL_HINT } = require("../gemini-fallback");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

const bases = [];
test.after(() => bases.forEach((b) => fs.rmSync(b, { recursive: true, force: true })));

// Checked out with the machine's line endings (autocrlf).
const read = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

function makeRepos() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mana-gemini-"));
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
      execFile(cmd, args, { cwd, windowsHide: true }, (err, stdout, stderr) =>
        resolve({ code: err ? err.code || 1 : 0, stdout: String(stdout), stderr: String(stderr) }),
      );
    });
}

// The fake gemini: answers --version, records each run (its arguments,
// stdin, folder, the settings and policy it was given, what it could see)
// and writes the files behaviour.json says, then prints its JSON.
const FAKE = `const fs = require("fs");
const path = require("path");
const b = JSON.parse(fs.readFileSync(path.join(__dirname, "behaviour.json"), "utf8"));
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(b.version || "0.9.0");
  process.exit(0);
}
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const file = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  const settings = file ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  const callsFile = path.join(__dirname, "calls.json");
  const calls = fs.existsSync(callsFile) ? JSON.parse(fs.readFileSync(callsFile, "utf8")) : [];
  calls.push({
    args,
    input,
    cwd: process.cwd(),
    settings,
    policy: settings ? fs.readFileSync(settings.adminPolicyPaths[0], "utf8") : null,
    trust: process.env.GEMINI_CLI_TRUST_WORKSPACE,
    envKeys: Object.keys(process.env),
    nodeModules: fs.existsSync(path.join(process.cwd(), "node-bot", "node_modules")),
  });
  fs.writeFileSync(callsFile, JSON.stringify(calls));
  if (b.hang) return setInterval(() => {}, 1000);
  for (const [rel, content] of Object.entries(b.writes || {})) {
    fs.mkdirSync(path.dirname(path.join(process.cwd(), rel)), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), rel), content);
  }
  process.stdout.write(b.stdout !== undefined ? b.stdout : JSON.stringify({ response: "I made add() add.", stats: {} }));
  process.exit(b.exitCode || 0);
});
`;

function fakeGemini(base, behaviour = {}) {
  const dir = path.join(base, "fake-gemini");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "gemini.js"), FAKE);
  fs.writeFileSync(path.join(dir, "behaviour.json"), JSON.stringify(behaviour));
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(home, ".gemini"), { recursive: true });
  fs.writeFileSync(path.join(home, ".gemini", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } }));
  const callsFile = path.join(dir, "calls.json");
  return { bin: path.join(dir, "gemini.js"), home, calls: () => (fs.existsSync(callsFile) ? JSON.parse(fs.readFileSync(callsFile, "utf8")) : []) };
}

function fallback(base, fake, env = {}) {
  return createGeminiFallback({
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DISCORD_TOKEN: "super-secret-token-value", MANA_SELF_WORK_GEMINI_CLI: fake.bin, ...env },
    ledgerFile: path.join(base, "gemini-runs.json"),
    home: fake.home,
  });
}

// One script per loop call: her own attempt, then her takeover.
function loops(...scripts) {
  const seen = [];
  let i = 0;
  const runLoop = async (prompt, policy, opts) => {
    const [calls, answer] = scripts[i++] || [[], "Not done yet."];
    seen.push({ prompt, opts });
    for (const [name, args] of calls) {
      try {
        seen.push({ name, result: await policy.executeTool(name, args) });
      } catch (e) {
        seen.push({ name, error: e.message });
      }
    }
    return { content: answer };
  };
  return { runLoop, seen };
}

const FIXED = "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n";
const UTIL_TEST = 'const test = require("node:test");\ntest("add adds", () => {});\n';
const plan = ["self_work__plan", { steps: ["Make add() add", "Test it"], no_test: "scripted" }];
const fix = ["coding__propose_edit", { path: "node-bot/util.js", old_text: "return a - b;", new_text: "return a + b;" }];
const runTests = ["coding__run_tests", { path: "node-bot/test/util.test.js" }];
const reviews = ["correctness", "edge cases", "scope"].map((pass) => ["self_work__review", { pass }]);
const finish = ["session_goal__finish", { reason: "done" }];
// Her own attempt that gets nowhere, and her takeover of Gemini's change.
const ownFails = [[], "Not done yet: I couldn't find it."];
const takeover = [[runTests, ...reviews, finish], "Gemini's change makes add() add; util.test.js covers it and passes."];

function selfWork(repos, gemini, scripts, { events = [], testsPass = true } = {}) {
  const ghCalls = [];
  const loop = loops(...scripts);
  const sw = createSelfWork({
    repoRoot: repos.live,
    worktreesDir: repos.worktrees,
    exec: fakeExec(ghCalls),
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, MANA_SELF_WORK_ATTEMPTS: "1" },
    protectedPaths: guard,
    gemini,
    reviewEdit: async () => null,
    runLoop: loop.runLoop,
    runTests: async () => ({ exitCode: testsPass ? 0 : 1, timedOut: false, output: testsPass ? "ok" : "not ok 1 - add adds\n# fail 1" }),
    onEvent: (run, text, notice) => events.push({ text, notice }),
    ramPercent: () => 50,
  });
  return { sw, ghCalls, seen: loop.seen };
}

async function runIssue(sw) {
  assert.equal((await sw.start(7)).ok, true);
  await sw._current().done;
  return sw.status();
}

test("#1269: when her attempts fail, Gemini CLI runs in her worktree with only file tools; she takes it over and the PR says where it came from", async () => {
  const repos = makeRepos();
  const fake = fakeGemini(repos.base, { writes: { "node-bot/util.js": FIXED, "node-bot/test/util.test.js": UTIL_TEST } });
  const gemini = fallback(repos.base, fake);
  const { sw, ghCalls, seen } = selfWork(repos, gemini, [ownFails, takeover]);
  const status = await runIssue(sw);

  assert.equal(status.state, "pr-open", status.step);
  const [call] = fake.calls();
  const worktree = path.join(repos.worktrees, "mana-7");
  assert.equal(fs.realpathSync.native(call.cwd), fs.realpathSync.native(worktree));
  // Headless, prompt on stdin, edits auto-approved; no shell, web or MCP.
  assert.deepEqual(call.args, ["--output-format", "json", "--approval-mode", "auto_edit", "-e", "none"]);
  assert.match(call.input, /Issue #7: Fix the add helper\nadd\(\) subtracts\./);
  assert.deepEqual(call.settings.tools.core, TOOLS);
  assert.ok(!TOOLS.includes("run_shell_command") && !TOOLS.includes("web_fetch"));
  assert.match(call.policy, /toolName = "\*"\ndecision = "deny"/);
  assert.equal(call.trust, "true");
  assert.ok(!call.envKeys.includes("DISCORD_TOKEN"), "the backend's secrets stay out of its environment");
  assert.equal(call.nodeModules, false, "node_modules' link is out of its reach while it runs");
  assert.ok(fs.existsSync(path.join(worktree, "node-bot", "node_modules", "dep", "index.js")), "and back afterwards");

  // She took it over: the three passes and her finish ran on its diff.
  assert.match(seen.find((s) => s.opts?.goal?.includes("Gemini CLI"))?.prompt || "", /Files it changed:\n- node-bot\/test\/util\.test\.js\n- node-bot\/util\.js/);
  assert.equal(seen.filter((s) => s.name === "self_work__review" && s.result).length, 3);
  assert.equal(read(path.join(worktree, "node-bot", "util.js")), FIXED);
  const create = ghCalls.find((a) => a[0] === "pr" && a[1] === "create");
  const body = create[create.indexOf("--body") + 1];
  assert.match(body, /## Where this came from\nNone of my 1 local attempt passed, so this change came from my Gemini fallback \(Gemini CLI, model: default\)/);
  assert.match(body, /## What changed\nGemini's change makes add\(\) add/);
  const [run] = JSON.parse(fs.readFileSync(path.join(repos.base, "gemini-runs.json"), "utf8"));
  assert.equal(run.issue, 7);
  assert.equal(run.outcome, "ok");
  assert.equal(typeof run.ms, "number");
  assert.deepEqual(Object.keys(run).sort(), ["at", "day", "issue", "model", "ms", "outcome"]);
});

test("#1269: when her own attempt passes, Gemini CLI never runs", async () => {
  const repos = makeRepos();
  const fake = fakeGemini(repos.base, { writes: { "node-bot/util.js": FIXED } });
  const { sw } = selfWork(repos, fallback(repos.base, fake), [[[plan, fix, runTests, ...reviews, finish], "I made add() add."]]);
  const status = await runIssue(sw);
  assert.equal(status.state, "pr-open", status.step);
  assert.deepEqual(fake.calls(), []);
});

test("#1269: a change to her guardrails, CI, a credential or node_modules is reverted and refused, and no PR opens", async () => {
  const repos = makeRepos();
  const fake = fakeGemini(repos.base, {
    writes: {
      "node-bot/util.js": FIXED,
      ".github/workflows/ci.yml": "on: push\n",
      "node-bot/approval-gate.js": "// off\n",
      "node-bot/.env": "X=1\n",
      "node-bot/node_modules/evil.js": "// planted\n",
    },
  });
  const events = [];
  const { sw, ghCalls } = selfWork(repos, fallback(repos.base, fake), [ownFails, takeover], { events });
  const status = await runIssue(sw);

  // Her own attempt changed nothing, and that is what is left.
  assert.equal(status.state, "no-change", status.step);
  assert.match(status.step, /My Gemini fallback's change touched .*\.github\/workflows\/ci\.yml.*node-bot\/approval-gate\.js/);
  assert.ok(events.some((e) => e.notice && /reverted its change and refused it/.test(e.text)));
  assert.ok(!ghCalls.some((a) => a[0] === "pr" && a[1] === "create"));
  const worktree = path.join(repos.worktrees, "mana-7");
  assert.equal(fs.existsSync(path.join(worktree, ".github")), false);
  assert.equal(fs.existsSync(path.join(worktree, "node-bot", ".env")), false);
  assert.equal(read(path.join(worktree, "node-bot", "approval-gate.js")), "// guard\n");
  assert.equal(read(path.join(worktree, "node-bot", "util.js")), "function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n");
  // The planted file went with the folder it made; the live packages are untouched.
  assert.equal(fs.existsSync(path.join(repos.live, "node-bot", "node_modules", "evil.js")), false);
  assert.ok(fs.existsSync(path.join(worktree, "node-bot", "node_modules", "dep", "index.js")));
});

test("#1269: without her three review passes there's no PR, whatever Gemini CLI did", async () => {
  const repos = makeRepos();
  const fake = fakeGemini(repos.base, { writes: { "node-bot/util.js": FIXED, "node-bot/test/util.test.js": UTIL_TEST } });
  const { sw, ghCalls, seen } = selfWork(repos, fallback(repos.base, fake), [ownFails, [[runTests, finish], "Looks fine."]]);
  const status = await runIssue(sw);
  assert.equal(status.state, "not-done", status.step);
  assert.match(seen.find((s) => s.name === "session_goal__finish")?.error || "", /review your diff with self_work__review/);
  assert.ok(!ghCalls.some((a) => a[0] === "pr" && a[1] === "create"));
});

test("#1269: her tests failing on Gemini CLI's change means no PR", async () => {
  const repos = makeRepos();
  const fake = fakeGemini(repos.base, { writes: { "node-bot/util.js": FIXED, "node-bot/test/util.test.js": UTIL_TEST } });
  const { sw, ghCalls } = selfWork(repos, fallback(repos.base, fake), [ownFails, takeover], { testsPass: false });
  const status = await runIssue(sw);
  assert.notEqual(status.state, "pr-open", status.step);
  assert.ok(!ghCalls.some((a) => a[0] === "pr" && a[1] === "create"));
});

test("#1269: one Gemini run per issue: a second run of the issue doesn't ask it again", async () => {
  const repos = makeRepos();
  const fake = fakeGemini(repos.base, { writes: { "node-bot/util.js": FIXED } });
  const gemini = fallback(repos.base, fake);
  fs.writeFileSync(path.join(repos.base, "gemini-runs.json"), JSON.stringify([{ at: "x", day: "2000-01-01", issue: 7, ms: 1, outcome: "error", model: "default" }]));
  const { sw } = selfWork(repos, gemini, [ownFails]);
  const status = await runIssue(sw);
  assert.equal(status.state, "no-change", status.step);
  assert.deepEqual(fake.calls(), []);
  assert.ok(status.log.some((l) => /No Gemini fallback: I've already asked Gemini CLI about #7 \(the cap is 1 per issue\)/.test(l.text)));
});

test("#1269: a quota error stops cleanly with a notice, and no more runs that day", async () => {
  const repos = makeRepos();
  const fake = fakeGemini(repos.base, {
    exitCode: 1,
    stdout: JSON.stringify({ error: { type: "Error", message: "[API Error: 429 RESOURCE_EXHAUSTED: You have exhausted your daily quota]", code: 1 } }),
  });
  const gemini = fallback(repos.base, fake, { MANA_SELF_WORK_GEMINI_PER_ISSUE: "5" });
  const events = [];
  const { sw } = selfWork(repos, gemini, [ownFails], { events });
  const status = await runIssue(sw);
  assert.equal(status.state, "no-change", status.step);
  assert.ok(events.some((e) => e.notice && /out of quota for today/.test(e.text)));
  assert.match(status.step, /Gemini CLI was out of quota/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(repos.base, "gemini-runs.json"), "utf8"))[0].outcome, "quota");
  assert.match((await gemini.blocked(8)).why, /ran out of quota today/);
});

test("#1269: the daily cap counts every issue's runs", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mana-gemini-cap-"));
  bases.push(base);
  const fake = fakeGemini(base);
  const day = new Date().toLocaleDateString("sv");
  fs.writeFileSync(path.join(base, "gemini-runs.json"), JSON.stringify([1, 2].map((issue) => ({ day, issue, ms: 1, outcome: "ok" }))));
  assert.match((await fallback(base, fake, { MANA_SELF_WORK_GEMINI_PER_DAY: "2" }).blocked(3))?.why, /2 times today \(the cap is 2\)/);
  assert.equal(await fallback(base, fake, { MANA_SELF_WORK_GEMINI_PER_DAY: "3" }).blocked(3), null);
});

test("#1269: Gemini CLI missing shows as unavailable, with how to install it", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mana-gemini-missing-"));
  bases.push(base);
  const fake = fakeGemini(base);
  const gemini = fallback(base, fake, { MANA_SELF_WORK_GEMINI_CLI: "mana-test-no-such-gemini-cli" });
  const s = await gemini.state();
  assert.equal(s.enabled, false);
  assert.equal(s.installed, false);
  assert.ok(s.why.includes(INSTALL_HINT));
  assert.match(s.text, /^Gemini fallback: unavailable -- Gemini CLI isn't installed/);
  assert.ok((await gemini.blocked(7)).why.includes(INSTALL_HINT));
  // And GET /self-work carries the line.
  const sw = createSelfWork({ repoRoot: base, worktreesDir: path.join(base, "wt"), gemini, runLoop: async () => ({}) });
  assert.match(sw.status().gemini.text, /unavailable/);
});

test("#1269: off by setting, in local-only mode or signed out; on when found and signed in, with the model I pick", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mana-gemini-state-"));
  bases.push(base);
  const fake = fakeGemini(base, { version: "0.9.1" });
  assert.match((await fallback(base, fake, { MANA_SELF_WORK_GEMINI: "0" }).state()).why, /turned off/);
  assert.match((await fallback(base, fake, { MANA_LOCAL_ONLY: "1" }).state()).why, /local-only mode/);
  const on = await fallback(base, fake, { MANA_SELF_WORK_GEMINI_MODEL: "gemini-2.5-flash" }).state();
  assert.equal(on.enabled, true);
  assert.match(on.text, /on \(Gemini CLI 0\.9\.1, gemini-2\.5-flash; 0 of 5 runs used today, 1 per issue\)/);
  assert.match((await fallback(base, fake, { MANA_SELF_WORK_GEMINI_MODEL: "x & calc" }).state()).why, /isn't a model name/);
  fs.rmSync(path.join(fake.home, ".gemini", "settings.json"));
  assert.match((await fallback(base, fake).state()).why, /isn't signed in/);

  const wt = path.join(base, "wt");
  fs.mkdirSync(wt);
  const g = await fallback(base, fake, { MANA_SELF_WORK_GEMINI_MODEL: "gemini-2.5-flash" }).run({ worktree: wt, prompt: "hi", issue: 1 });
  assert.equal(g.outcome, "ok");
  assert.deepEqual(fake.calls().pop().args.slice(-2), ["-m", "gemini-2.5-flash"]);
});

test("#1269: includeDirectories in my Gemini settings means no run: unavailable, with a notice", async () => {
  const repos = makeRepos();
  const fake = fakeGemini(repos.base, { writes: { "node-bot/util.js": FIXED } });
  const settings = path.join(fake.home, ".gemini", "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } }, context: { includeDirectories: [repos.live] } }));
  const gemini = fallback(repos.base, fake);
  const s = await gemini.state();
  assert.equal(s.enabled, false);
  assert.match(s.text, /^Gemini fallback: unavailable -- Gemini CLI's settings add folders to its workspace \(includeDirectories in .*settings\.json\)/);
  const events = [];
  const { sw } = selfWork(repos, gemini, [ownFails], { events });
  await runIssue(sw);
  assert.ok(events.some((e) => e.notice && /No Gemini fallback: Gemini CLI's settings add folders/.test(e.text)));
  assert.deepEqual(fake.calls(), []);
  // An empty list is fine.
  fs.writeFileSync(settings, JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } }, context: { includeDirectories: [] } }));
  assert.equal((await fallback(repos.base, fake).state()).enabled, true);
});

test("#1269: a worktree whose project settings add folders isn't run in", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mana-gemini-project-"));
  bases.push(base);
  const fake = fakeGemini(base);
  const wt = path.join(base, "wt");
  fs.mkdirSync(path.join(wt, ".gemini"), { recursive: true });
  fs.writeFileSync(path.join(wt, ".gemini", "settings.json"), '{ "context": { "includeDirectories": ["D:/Mana"] } }');
  const g = await fallback(base, fake).run({ worktree: wt, prompt: "hi", issue: 1 });
  assert.equal(g.outcome, "unsafe-settings");
  assert.deepEqual(fake.calls(), []);
});

test("#1269: a Gemini change no test can judge (no node test covers it) gets no PR", async () => {
  const repos = makeRepos();
  const fake = fakeGemini(repos.base, { writes: { "windows-native-launcher/Adder.cs": "class Adder {}\n" } });
  const { sw, ghCalls } = selfWork(repos, fallback(repos.base, fake), [ownFails, [[["coding__run_tests", {}], ...reviews, finish], "Added Adder."]]);
  const status = await runIssue(sw);
  assert.equal(status.state, "tests-failing", status.step);
  assert.ok(status.log.some((l) => /My tests on Gemini CLI's change can't judge it: no tests to judge it by/.test(l.text)));
  assert.ok(!ghCalls.some((a) => a[0] === "pr" && a[1] === "create"));
});

test("#1269: Stop ends a Gemini CLI run under way; its run was logged as it started", async () => {
  const repos = makeRepos();
  const fake = fakeGemini(repos.base, { hang: true });
  const { sw } = selfWork(repos, fallback(repos.base, fake), [ownFails]);
  assert.equal((await sw.start(7)).ok, true);
  const ledger = path.join(repos.base, "gemini-runs.json");
  for (let i = 0; i < 300 && !fake.calls().length; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fake.calls().length, 1, "it started");
  assert.equal(JSON.parse(fs.readFileSync(ledger, "utf8"))[0].outcome, "started");
  assert.equal(sw.stop(), true);
  await sw._current().done;
  assert.equal(sw.status().state, "stopped", sw.status().step);
  assert.equal(JSON.parse(fs.readFileSync(ledger, "utf8"))[0].outcome, "stopped");
});
