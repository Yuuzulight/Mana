// #1265: Mana keeps Folio up to date. Real git against a throwaway origin, fake gh.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const { createApprovalGate } = require("../approval-gate");
const { runCommand } = require("../ai/git-tool-source");
const { createFolioUpdater, isGreen, packVersion, mergedPrs } = require("../folio-update");

const PIN = "a".repeat(40);
const NEW = "b".repeat(40);
const OLDER = "c".repeat(40);
const CSPROJ = "windows-native-launcher/ManaNativeLauncher.csproj";
const PROPS = "<Project><PropertyGroup><VersionPrefix>0.1.0</VersionPrefix>\n<VersionSuffix>m1.$(FolioBuild)</VersionSuffix></PropertyGroup></Project>";
const GREEN = [
  { name: "build-and-test (ubuntu-latest)", status: "completed", conclusion: "success" },
  { name: "build-and-test (windows-latest)", status: "completed", conclusion: "success" },
];
const RED = [GREEN[0], { ...GREEN[1], conclusion: "failure" }];

const bases = [];
test.after(() => bases.forEach((b) => fs.rmSync(b, { recursive: true, force: true })));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function makeRepos() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mana-folio-"));
  bases.push(base);
  const origin = path.join(base, "origin.git");
  const live = path.join(base, "live");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  git(base, "clone", "-q", origin, live);
  git(live, "config", "user.name", "Yuuzulight");
  git(live, "config", "user.email", "y@example.com");
  fs.mkdirSync(path.join(live, "windows-native-launcher"));
  fs.writeFileSync(path.join(live, CSPROJ), `<Project>\n  <PropertyGroup>\n    <FolioCommit>${PIN}</FolioCommit>\n    <FolioVersion>0.1.0-m1.204</FolioVersion>\n  </PropertyGroup>\n</Project>\n`);
  git(live, "add", "-A");
  git(live, "commit", "-q", "-m", "init");
  git(live, "push", "-q", "origin", "main");
  return { base, origin, live, worktrees: path.join(base, "worktrees"), statePath: path.join(base, "data", "folio-update.json") };
}

// gh answers: newest runs first; checks per sha; the PR's checks.
function fakeGh({ runs = [NEW, OLDER], checks = { [NEW]: GREEN, [OLDER]: GREEN, [PIN]: GREEN }, prChecks = [], prState = "OPEN", prList = [] } = {}) {
  const calls = [];
  const answer = (args) => {
    const [a, b] = args;
    const json = (v) => ({ code: 0, stdout: JSON.stringify(v), stderr: "" });
    if (a === "api" && /actions\/runs/.test(b)) return json(runs);
    if (a === "api" && /check-runs/.test(b)) return json(checks[b.split("/")[4]] || []);
    if (a === "api" && b === "--paginate") {
      return { code: 0, stdout: [JSON.stringify("Merge pull request #12 from Yuuzulight/x\n\nDraw tables"), JSON.stringify("Fix a typo")].join("\n"), stderr: "" };
    }
    if (a === "api" && /compare/.test(b)) return json({ status: "ahead", ahead_by: 3 });
    if (a === "api" && /contents/.test(b)) return { code: 0, stdout: PROPS, stderr: "" };
    if (a === "api" && b === "graphql") return json({ data: { repository: { object: { history: { totalCount: 300 } } } } });
    if (a === "issue" && b === "list") return json([]);
    if (a === "issue" && b === "create") return { code: 0, stdout: "https://github.com/x/y/issues/70\n", stderr: "" };
    if (a === "pr" && b === "list") return json(prList);
    if (a === "pr" && b === "create") return { code: 0, stdout: "https://github.com/x/y/pull/71\n", stderr: "" };
    if (a === "pr" && b === "merge") return { code: 0, stdout: "", stderr: "" };
    if (a === "pr" && b === "view") return json({ state: prState });
    if (a === "pr" && b === "checks") return { ...json(prChecks), code: prChecks.some((c) => c.bucket === "fail") ? 1 : 0 };
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  const exec = async (cmd, args, opts) => {
    if (cmd !== "gh") return runCommand(cmd, args, opts);
    calls.push(args);
    return answer(args);
  };
  return { exec, calls };
}

function updater(repos, gh, { mode = "off", state } = {}) {
  const gate = createApprovalGate({ dataDir: path.join(repos.base, "gate") });
  gate.setGitApprovalMode("github", mode);
  if (state) {
    fs.mkdirSync(path.dirname(repos.statePath), { recursive: true });
    fs.writeFileSync(repos.statePath, JSON.stringify(state));
  }
  const notices = [];
  const u = createFolioUpdater({ repoRoot: repos.live, worktreesDir: repos.worktrees, exec: gh.exec, approvalGate: gate, statePath: repos.statePath, notify: (n) => notices.push(n) });
  return { u, gate, notices };
}

const writes = (calls) => calls.filter((a) => ["create", "merge"].includes(a[1]) || a[0] === "push");

test("the version is Folio's own: prefix, suffix and the commit count", () => {
  assert.equal(packVersion(PROPS, 629), "0.1.0-m1.629");
  assert.equal(packVersion(PROPS.replace("m1.", "m2."), 7), "0.1.0-m2.7");
  assert.throws(() => packVersion(PROPS.replace("$(FolioBuild)", "$(Other)"), 7), /can't work out/);
  assert.equal(isGreen(GREEN), true);
  assert.equal(isGreen(RED), false);
  assert.equal(isGreen([GREEN[0]]), false, "both OSes");
  assert.equal(isGreen([GREEN[0], { ...GREEN[1], status: "in_progress", conclusion: null }]), false);
  assert.deepEqual(mergedPrs(["Merge pull request #12 from a/b\n\nDraw tables", "Fix"]), [{ number: 12, title: "Draw tables" }]);
});

test("a newer green Folio commit becomes a PR with auto-merge, off a throwaway worktree", async () => {
  const repos = makeRepos();
  const gh = fakeGh();
  const { u, notices } = updater(repos, gh);
  const result = await u.run();
  assert.equal(result.status, "opened", JSON.stringify(result));
  assert.equal(result.sha, NEW);

  const branch = `folio/${NEW.slice(0, 12)}`;
  const csproj = git(repos.origin, "show", `${branch}:${CSPROJ}`);
  assert.match(csproj, new RegExp(`<FolioCommit>${NEW}</FolioCommit>`));
  assert.match(csproj, /<FolioVersion>0\.1\.0-m1\.300<\/FolioVersion>/);
  assert.equal(git(repos.origin, "log", "-1", "--format=%an", branch), "Yuuzulight");
  assert.equal(git(repos.origin, "log", "-1", "--format=%B", branch), `Update Folio to ${NEW.slice(0, 7)} (0.1.0-m1.300)`, "no trailers");
  assert.equal(git(repos.origin, "show", `main:${CSPROJ}`).includes(PIN), true, "main untouched");
  assert.equal(fs.existsSync(path.join(repos.worktrees, `folio-${NEW.slice(0, 12)}`)), false, "worktree removed");
  assert.equal(git(repos.live, "rev-parse", "--abbrev-ref", "HEAD"), "main", "the live checkout stays put");

  const create = gh.calls.find((a) => a[0] === "pr" && a[1] === "create");
  const body = create[create.indexOf("--body") + 1];
  assert.match(body, /Part of #70\./);
  assert.match(body, /Yuuzulight\/Folio#12 Draw tables/);
  assert.doesNotMatch(body, /claude|co-authored|the user|agent/i);
  assert.deepEqual(gh.calls.find((a) => a[1] === "merge"), ["pr", "merge", "71", "--auto", "--merge"]);
  assert.equal(gh.calls.filter((a) => a[0] === "issue" && a[1] === "create").length, 1);
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /#71/);
  assert.equal(u.status().tried[NEW].state, "open");

  // While it's open, the next run waits for it.
  const next = await u.run();
  assert.equal(next.status, "waiting");
  assert.equal(gh.calls.filter((a) => a[1] === "create").length, 2, "nothing new opened");
});

test("nothing happens when the newest green commit is the pin, CI is red, it was tried, or the toggle is off", async () => {
  for (const [label, ghOptions, state, expected] of [
    ["not newer", { runs: [PIN] }, undefined, "current"],
    ["red CI", { runs: [NEW], checks: { [NEW]: RED } }, undefined, "current"],
    ["already tried", {}, { tried: { [NEW]: { pr: 60, state: "failed" } } }, "tried"],
    ["PR already there", { prList: [{ number: 61, state: "CLOSED", url: "u" }] }, undefined, "tried"],
    ["off", {}, { enabled: false }, "off"],
  ]) {
    const repos = makeRepos();
    const gh = fakeGh(ghOptions);
    const { u, notices } = updater(repos, gh, { state });
    const result = await u.run();
    assert.equal(result.status, expected, label);
    assert.deepEqual(writes(gh.calls), [], label);
    assert.deepEqual(notices, [], label);
    assert.equal(git(repos.origin, "branch", "--list", "folio/*"), "", label);
  }
});

test("an older green commit when the newest one's CI failed", async () => {
  const repos = makeRepos();
  const gh = fakeGh({ checks: { [NEW]: RED, [OLDER]: GREEN } });
  const { u } = updater(repos, gh);
  const result = await u.run();
  assert.equal(result.status, "opened");
  assert.equal(result.sha, OLDER);
});

test("a bump PR whose CI fails: a notice with the failing check, left open, never retried", async () => {
  const repos = makeRepos();
  const failing = [
    { name: "Build and test windows-native-launcher", bucket: "fail", link: "https://ci/1" },
    { name: "Node tests (full suite)", bucket: "pass", link: "https://ci/2" },
  ];
  const gh = fakeGh({ prChecks: failing });
  const { u, notices } = updater(repos, gh, { state: { tried: { [NEW]: { pr: 71, url: "https://github.com/x/y/pull/71", state: "open" } } } });
  const result = await u.run();
  assert.equal(result.status, "tried");
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /#71.*failed CI: Build and test windows-native-launcher/);
  assert.equal(notices[0].url, "https://ci/1");
  assert.equal(u.status().tried[NEW].state, "failed");
  assert.deepEqual(writes(gh.calls), [], "not closed, not merged, not retried");

  const again = await u.run();
  assert.equal(again.status, "tried");
  assert.equal(notices.length, 1, "one notice");
});

test("through the approval setting: asks first, opens it once I allow it", async () => {
  const repos = makeRepos();
  const gh = fakeGh();
  const { u, gate } = updater(repos, gh, { mode: "ask" });
  const result = await u.run();
  assert.equal(result.status, "pending");
  assert.deepEqual(writes(gh.calls), [], "nothing before I allow it");
  assert.equal((await u.run()).status, "pending", "asked once");
  assert.equal(gate.listPending().length, 1);
  const [request] = gate.listPending();
  assert.match(request.summary, /auto-merge/);
  const decided = await gate.decide(request.id, "allow-once");
  assert.equal(decided.status, "approved");
  assert.ok(gh.calls.some((a) => a[0] === "pr" && a[1] === "create"));
  assert.ok(git(repos.origin, "branch", "--list", `folio/${NEW.slice(0, 12)}`));
});

test("the routes need my admin key", async () => {
  const { createApp } = require("../server");
  const { withServer, useTestAdminToken } = require("./helpers");
  const fetchAsAdmin = useTestAdminToken();
  const calls = [];
  const fake = {
    run: async () => (calls.push("run"), { status: "current" }),
    status: () => ({ enabled: true, tried: {} }),
    setEnabled: (on) => calls.push(on),
    ensureJob: () => {},
  };
  await withServer(createApp({ folioUpdater: fake }), async (baseUrl) => {
    const post = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await fetch(`${baseUrl}/folio-update/run`, post({}))).status, 401);
    assert.equal((await fetch(`${baseUrl}/folio-update`)).status, 401);
    assert.deepEqual(await (await fetchAsAdmin(`${baseUrl}/folio-update/run`, post({}))).json(), { status: "current" });
    assert.deepEqual(await (await fetchAsAdmin(`${baseUrl}/folio-update`, post({ enabled: false }))).json(), { enabled: true, tried: {} });
  });
  assert.deepEqual(calls, ["run", false]);
});
