// #1398: she watches CI on her own PR and fixes red checks (twice at most).
// Real git against a throwaway origin; gh, the clock and the loop are fakes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const { createSelfWork } = require("../self-work");
const { runCommand } = require("../ai/git-tool-source");
const { untrustedSources } = require("../ai/untrusted-content");

const BRANCH = "mana/7-fix-the-add-helper";
const bases = [];
test.after(() => bases.forEach((b) => fs.rmSync(b, { recursive: true, force: true })));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

// Her branch is on origin, and main has moved on without touching it, so
// the first refresh really merges and pushes (which starts the watch).
function makeRepos() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mana-ci-watch-"));
  bases.push(base);
  const origin = path.join(base, "origin.git");
  const live = path.join(base, "live");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  git(base, "clone", "-q", origin, live);
  git(live, "config", "user.name", "Test");
  git(live, "config", "user.email", "test@example.com");
  fs.mkdirSync(path.join(live, "node-bot", "test"), { recursive: true });
  fs.writeFileSync(path.join(live, "node-bot", "util.js"), "module.exports = { add: (a, b) => a + b };\n");
  git(live, "add", "-A");
  git(live, "commit", "-q", "-m", "init");
  git(live, "push", "-q", "origin", "main");
  git(live, "switch", "-q", "-c", BRANCH);
  fs.appendFileSync(path.join(live, "node-bot", "util.js"), "// hers\n");
  git(live, "commit", "-q", "-am", "hers");
  git(live, "push", "-q", "origin", BRANCH);
  git(live, "switch", "-q", "main");
  git(live, "branch", "-q", "-D", BRANCH);
  const other = path.join(base, "other");
  git(base, "clone", "-q", origin, other);
  fs.writeFileSync(path.join(other, "node-bot", "other.js"), "// main moved\n");
  git(other, "add", "-A");
  git(other, "-c", "user.name=O", "-c", "user.email=o@x", "commit", "-q", "-m", "main moves");
  git(other, "push", "-q", "origin", "main");
  return { base, origin, live, worktrees: path.join(base, "worktrees") };
}

const red = { name: "test", bucket: "fail", link: "https://github.com/o/r/actions/runs/9/job/555" };
const green = { name: "test", bucket: "pass", link: "https://github.com/o/r/actions/runs/9/job/555" };
const pending = { ...green, bucket: "pending" };

// polls: what `gh pr checks` answers per poll (the last one repeats).
async function watching(polls, { gaming = (sleeps) => false, ghLog = "boom\n" } = {}) {
  const repos = makeRepos();
  const worktree = path.join(repos.worktrees, "mana-7");
  const ghCalls = [];
  const prompts = [];
  const events = [];
  const clock = { sleeps: 0, gaming: false, checksWhenResumed: null };
  let checks = 0;
  const gh = (args) => {
    ghCalls.push(args);
    if (args[0] === "api" && args[1] === "user") return { code: 0, stdout: "Yuuzulight\n" };
    if (args[0] === "pr" && args[1] === "view") {
      return { code: 0, stdout: JSON.stringify({ number: 8, title: "Fix the add helper", state: "OPEN", headRefName: BRANCH, author: { login: "Yuuzulight" }, labels: [] }) };
    }
    // Like the real gh: non-zero while a check fails, JSON all the same.
    if (args[0] === "pr" && args[1] === "checks") {
      const answer = polls[Math.min(checks++, polls.length - 1)];
      return { code: answer.some((c) => c.bucket === "fail") ? 1 : 0, stdout: JSON.stringify(answer) };
    }
    if (args[0] === "run" && args[1] === "view") return { code: 0, stdout: ghLog };
    return { code: 0, stdout: "[]" };
  };
  const sw = createSelfWork({
    repoRoot: repos.live,
    worktreesDir: repos.worktrees,
    exec: async (cmd, args, opts) => (cmd === "gh" ? gh(args) : runCommand(cmd, args, opts)),
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DISCORD_TOKEN: "super-secret-token-value" },
    gitTools: { executeTool: async () => "[]" },
    // The first run is a plain refresh; a prompt that says CI is red is a fix.
    runLoop: async (prompt, policy, opts) => {
      prompts.push(prompt);
      opts.onRound?.(1, 1);
      fs.appendFileSync(path.join(worktree, "node-bot", "util.js"), `// round ${prompts.length}\n`);
      await policy.executeTool("coding__run_tests", { path: "node-bot/test/util.test.js" });
      await policy.executeTool("session_goal__finish", { reason: "done" });
      return { content: "Done." };
    },
    runTests: async () => ({ exitCode: 0, timedOut: false, output: "ok" }),
    onEvent: (run, text) => events.push(text),
    ramPercent: () => 50,
    isGaming: () => clock.gaming,
    watchCi: true,
    // No real waiting: each "minute" is a turn of the event loop.
    ciSleep: async () => {
      clock.sleeps++;
      clock.gaming = gaming(clock.sleeps);
      if (!clock.gaming && clock.resumedAt == null) clock.resumedAt = clock.sleeps;
      if (clock.sleeps === clock.resumedAt) clock.checksWhenResumed = checks;
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  assert.equal((await sw.refresh(8)).ok, true);
  await sw._current().done;
  assert.equal(sw.status().state, "pr-updated", sw.status().step);
  return { sw, repos, ghCalls, prompts, events, clock, checks: () => checks };
}

async function until(what, fn) {
  for (let i = 0; i < 400; i++) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`never saw: ${what}`);
}

test("#1398: all checks green ends the watch quietly, with a log line only", async () => {
  const { sw, events, ghCalls, prompts } = await watching([[pending], [green]]);
  await until("green", () => events.some((e) => /CI is green on my PR #8/.test(e)));
  assert.equal(prompts.length, 1, "no fix round");
  assert.equal(ghCalls.filter((a) => a[0] === "pr" && a[1] === "checks").length, 2);
  assert.ok(!ghCalls.some((a) => a[0] === "run"), "no log read");
  assert.equal(sw.status().kind, "refresh");
});

test("#1398: a red check gets its failing log tail (scrubbed, untrusted) in a fix round that is pushed; then green", async () => {
  const log = `${"x".repeat(5000)}\nsuper-secret-token-value\nAssertionError: add is wrong END`;
  const { sw, repos, events, ghCalls, prompts } = await watching([[red], [green]], { ghLog: log });
  await until("green after the fix", () => events.some((e) => /CI is green on my PR #8/.test(e)));
  assert.deepEqual(ghCalls.find((a) => a[0] === "run"), ["run", "view", "--job", "555", "--log-failed"]);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /CI is red/);
  assert.match(prompts[1], /AssertionError: add is wrong END/);
  assert.ok(!prompts[1].includes("super-secret-token-value"), "scrubbed");
  assert.ok(prompts[1].length < 6000 && !prompts[1].includes("x".repeat(3500)), "only the tail");
  assert.deepEqual(untrustedSources(prompts[1]), ["CI log"]);
  assert.equal(sw.status().kind, "ci-fix");
  assert.equal(git(repos.origin, "log", "-1", "--format=%s", BRANCH), "Fix CI on #8");
  assert.equal(git(repos.origin, "rev-parse", BRANCH), git(path.join(repos.worktrees, "mana-7"), "rev-parse", "HEAD"));
});

test("#1398: still red after two fix tries ends needs-you, naming the check and what she tried", async () => {
  const { sw, events, prompts } = await watching([[red]]);
  await until("needs-you", () => sw.status().state === "needs-you");
  assert.equal(prompts.length, 3, "the refresh and exactly two fix rounds");
  const text = sw.status().step;
  assert.match(text, /"test" keeps failing after 2 fix tries/);
  assert.match(text, /What I tried: 1\) .*fix for the failing "test" check.* 2\) /);
  assert.ok(events.some((e) => /keeps failing/.test(e)));
});

test("#1398: a game running pauses the watch without counting a poll or a try", async () => {
  const { events, clock, ghCalls, checks } = await watching([[green]], { gaming: (n) => n < 4 });
  await until("green", () => events.some((e) => /CI is green on my PR #8/.test(e)));
  assert.equal(clock.checksWhenResumed, 0, "no gh call while the game ran");
  assert.equal(checks(), 1);
  assert.ok(!ghCalls.some((a) => a[0] === "run"));
});

test("#1398: stop() cancels a watch that is waiting", async () => {
  const { sw, clock, checks } = await watching([[pending]]);
  await until("a poll", () => checks() >= 1);
  assert.equal(sw.stop(), true);
  const seen = checks();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(checks(), seen, "no more polls");
  assert.ok(clock.sleeps >= 1);
});
