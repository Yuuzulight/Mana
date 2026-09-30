// #1011: a revert PR for a merged PR, against a throwaway origin. Real git, fake gh.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFile, execFileSync } = require("node:child_process");

const { createReverter } = require("../revert-pr");

const bases = [];
test.after(() => bases.forEach((b) => fs.rmSync(b, { recursive: true, force: true })));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

// main with a merged PR (a --no-ff merge commit), pushed.
function makeRepos() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mana-revert-"));
  bases.push(base);
  const origin = path.join(base, "origin.git");
  const live = path.join(base, "live");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  git(base, "clone", "-q", origin, live);
  git(live, "config", "user.name", "Test");
  git(live, "config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(live, "a.txt"), "one\n");
  git(live, "add", "-A");
  git(live, "commit", "-q", "-m", "init");
  git(live, "checkout", "-q", "-b", "feat");
  fs.writeFileSync(path.join(live, "a.txt"), "two\n");
  git(live, "commit", "-q", "-am", "breaks it");
  git(live, "checkout", "-q", "main");
  git(live, "merge", "-q", "--no-ff", "feat", "-m", "Merge pull request #8");
  git(live, "push", "-q", "origin", "main");
  return { origin, live, worktrees: path.join(base, "worktrees"), merge: git(live, "rev-parse", "HEAD") };
}

function reverter(repos, { state = "MERGED" } = {}) {
  const ghCalls = [];
  const exec = (cmd, args, { cwd }) =>
    new Promise((resolve) => {
      if (cmd === "gh") {
        ghCalls.push(args);
        const out =
          args[0] === "pr" && args[1] === "view"
            ? JSON.stringify({ number: 8, title: "Change a", state, mergeCommit: state === "MERGED" ? { oid: repos.merge } : null })
            : args[0] === "issue"
              ? "https://github.com/x/y/issues/50\n"
              : "https://github.com/x/y/pull/51\n";
        return resolve({ code: 0, stdout: out, stderr: "" });
      }
      execFile(cmd, args, { cwd, windowsHide: true }, (err, stdout, stderr) =>
        resolve({ code: err ? err.code || 1 : 0, stdout: String(stdout), stderr: String(stderr) }),
      );
    });
  return { r: createReverter({ repoRoot: repos.live, worktreesDir: repos.worktrees, exec }), ghCalls };
}

test("a merged PR gets its own issue, then a pushed revert PR that closes it", async () => {
  const repos = makeRepos();
  const { r, ghCalls } = reverter(repos);
  const result = await r.revert(8, "the chat window stopped opening");
  assert.equal(result.ok, true, result.error);
  assert.equal(result.prUrl, "https://github.com/x/y/pull/51");
  assert.equal(result.mergeCommit, repos.merge);
  // The revert is on its own branch; main (origin's and the live one) keeps the change.
  assert.equal(git(repos.origin, "show", "revert/8:a.txt"), "one");
  assert.equal(git(repos.origin, "show", "main:a.txt"), "two");
  assert.equal(fs.readFileSync(path.join(repos.live, "a.txt"), "utf8").trim(), "two");
  const issue = ghCalls.findIndex((a) => a[0] === "issue" && a[1] === "create");
  const pr = ghCalls.findIndex((a) => a[0] === "pr" && a[1] === "create");
  assert.ok(issue >= 0 && pr > issue, "the issue comes first");
  assert.equal(ghCalls[issue][ghCalls[issue].indexOf("--title") + 1], "Revert #8: Change a");
  assert.match(ghCalls[issue][ghCalls[issue].indexOf("--body") + 1], /What broke: the chat window stopped opening/);
  const body = ghCalls[pr][ghCalls[pr].indexOf("--body") + 1];
  assert.match(body, /^Closes #50\.\n\nReverts #8/);
  assert.deepEqual(ghCalls[pr].slice(2, 6), ["--base", "main", "--head", "revert/8"]);
  assert.ok(!ghCalls.some((a) => a.includes("merge")), "never merged");
});

test("nothing to revert when the PR isn't merged, and no issue for a revert that conflicts", async () => {
  const open = reverter(makeRepos(), { state: "OPEN" });
  assert.match((await open.r.revert(8)).error, /isn't merged/);

  const repos = makeRepos();
  fs.writeFileSync(path.join(repos.live, "a.txt"), "three\n");
  git(repos.live, "commit", "-q", "-am", "later change");
  git(repos.live, "push", "-q", "origin", "main");
  const { r, ghCalls } = reverter(repos);
  const result = await r.revert(8);
  assert.equal(result.ok, false);
  assert.match(result.error, /doesn't revert cleanly/);
  assert.ok(!ghCalls.some((a) => a[1] === "create"));
  assert.equal(git(path.join(repos.worktrees, "revert-8"), "status", "--porcelain"), "");
});

test("the route needs my admin key", async () => {
  const { createApp } = require("../server");
  const { withServer, useTestAdminToken } = require("./helpers");
  const fetchAsAdmin = useTestAdminToken();
  const calls = [];
  const fake = { revert: async (pr, reason) => (calls.push([pr, reason]), { ok: true, prUrl: "u" }) };
  await withServer(createApp({ reverter: fake }), async (baseUrl) => {
    const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pr: 8, reason: "broke" }) };
    assert.equal((await fetch(`${baseUrl}/updates/revert`, init)).status, 401);
    assert.deepEqual(await (await fetchAsAdmin(`${baseUrl}/updates/revert`, init)).json(), { ok: true, prUrl: "u" });
  });
  assert.deepEqual(calls, [[8, "broke"]]);
});
