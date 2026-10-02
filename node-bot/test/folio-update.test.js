// #1265: Mana keeps Folio up to date. Real git against a throwaway origin, fake gh.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const { createApprovalGate } = require("../approval-gate");
const { runCommand } = require("../ai/git-tool-source");
const { LAUNCHER_CHECK, createFolioUpdater, isGreen, packVersion, prVerdict, mergedPrs } = require("../folio-update");

const PIN = "a".repeat(40);
const NEW = "b".repeat(40);
const OLDER = "c".repeat(40);
const HEAD = "d".repeat(40); // the bump PR's head commit
const CSPROJ = "windows-native-launcher/ManaNativeLauncher.csproj";
const PROPS = "<Project><PropertyGroup><VersionPrefix>0.1.0</VersionPrefix>\n<VersionSuffix>m1.$(FolioBuild)</VersionSuffix></PropertyGroup></Project>";
const GREEN = [
  { name: "build-and-test (ubuntu-latest)", status: "completed", conclusion: "success" },
  { name: "build-and-test (windows-latest)", status: "completed", conclusion: "success" },
];
const RED = [GREEN[0], { ...GREEN[1], conclusion: "failure" }];
// The bump PR's own checks.
const run = (name, conclusion = "success", status = "completed") => ({ name, status, conclusion: status === "completed" ? conclusion : null, url: `https://ci/${name}` });
const PR_GREEN = [run(LAUNCHER_CHECK), run("Node tests (full suite)"), run("dco"), run("build")];
const OPEN_PR = { tried: { [NEW]: { pr: 71, url: "https://github.com/x/y/pull/71", state: "open" } } };

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

// gh answers: Folio's newest runs first and checks per sha; the bump PR's state, mergeability and checks.
function fakeGh({ runs = [NEW, OLDER], checks = { [NEW]: GREEN, [OLDER]: GREEN, [PIN]: GREEN }, prChecks = [], prState = "OPEN", mergeable = "MERGEABLE", prList = [], createdAt = new Date().toISOString() } = {}) {
  const calls = [];
  const answer = (args) => {
    const [a, b] = args;
    const json = (v) => ({ code: 0, stdout: JSON.stringify(v), stderr: "" });
    if (a === "api" && /actions\/runs/.test(b)) return json(runs);
    if (a === "api" && b === `repos/{owner}/{repo}/commits/${HEAD}/check-runs?per_page=100`) return json(prChecks);
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
    if (a === "pr" && b === "view") return json({ state: prState, mergeable, headRefOid: HEAD, createdAt });
    if (a === "pr" && b === "close") return { code: 0, stdout: "", stderr: "" };
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  const exec = async (cmd, args, opts) => {
    if (cmd !== "gh") return runCommand(cmd, args, opts);
    calls.push(args);
    return answer(args);
  };
  return { exec, calls };
}

function updater(repos, gh, { mode = "off", state, now } = {}) {
  const gate = createApprovalGate({ dataDir: path.join(repos.base, "gate") });
  gate.setGitApprovalMode("github", mode);
  if (state) {
    fs.mkdirSync(path.dirname(repos.statePath), { recursive: true });
    fs.writeFileSync(repos.statePath, JSON.stringify(state));
  }
  const notices = [];
  const u = createFolioUpdater({ repoRoot: repos.live, worktreesDir: repos.worktrees, exec: gh.exec, approvalGate: gate, statePath: repos.statePath, notify: (n) => notices.push(n), now });
  return { u, gate, notices };
}

const writes = (calls) => calls.filter((a) => ["create", "merge", "close"].includes(a[1]) || a[0] === "push");
const merges = (calls) => calls.filter((a) => a[0] === "pr" && a[1] === "merge");

test("the version is Folio's own; which commits and PRs count as green", () => {
  assert.equal(packVersion(PROPS, 629), "0.1.0-m1.629");
  assert.equal(packVersion(PROPS.replace("m1.", "m2."), 7), "0.1.0-m2.7");
  assert.throws(() => packVersion(PROPS.replace("$(FolioBuild)", "$(Other)"), 7), /can't work out/);
  assert.equal(isGreen(GREEN), true);
  assert.equal(isGreen(RED), false);
  assert.equal(isGreen([GREEN[0]]), false, "both OSes");
  assert.equal(isGreen([GREEN[0], { ...GREEN[1], status: "in_progress", conclusion: null }]), false);
  assert.deepEqual(mergedPrs(["Merge pull request #12 from a/b\n\nDraw tables", "Fix"]), [{ number: 12, title: "Draw tables" }]);

  assert.deepEqual(prVerdict(PR_GREEN, "MERGEABLE"), { merge: true });
  assert.match(prVerdict(PR_GREEN, "UNKNOWN").wait, /whether it can merge/, "mergeable not known yet: wait");
  assert.equal(prVerdict(PR_GREEN.slice(1), "MERGEABLE").wait, `${LAUNCHER_CHECK} (missing)`, "no launcher check yet: wait");
  assert.equal(prVerdict([...PR_GREEN, run("CodeQL", null, "in_progress")], "MERGEABLE").wait, "CodeQL (in_progress)", "pending: wait");
  assert.equal(prVerdict([...PR_GREEN, run("CodeQL", "skipped")], "MERGEABLE").wait, "CodeQL (skipped)", "skipped: wait");
  assert.equal(prVerdict([...PR_GREEN, run("CodeQL", "neutral")], "MERGEABLE").wait, "CodeQL (neutral)", "neutral: wait");
  assert.equal(prVerdict([run(LAUNCHER_CHECK, "cancelled"), run("dco", null, "queued")], "MERGEABLE").fail, `${LAUNCHER_CHECK} (cancelled)`);
  assert.match(prVerdict(PR_GREEN, "CONFLICTING").fail, /conflicts/);
});

test("a newer green Folio commit becomes a PR off a throwaway worktree, not merged yet", async () => {
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
  assert.deepEqual(merges(gh.calls), [], "no auto-merge, no merge yet");
  assert.equal(gh.calls.filter((a) => a[0] === "issue" && a[1] === "create").length, 1);
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /#71/);
  assert.equal(u.status().tried[NEW].state, "open");

  // An hour later its checks haven't run: it waits.
  const next = await u.run();
  assert.equal(next.status, "waiting");
  assert.equal(writes(gh.calls).length, 2, "nothing new opened, nothing merged");
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

test("Folio itself is looked at once a day; Check now looks whenever", async () => {
  const repos = makeRepos();
  const gh = fakeGh({ runs: [PIN] });
  let clock = 1_000_000_000;
  const { u } = updater(repos, gh, { now: () => clock });
  const looks = () => gh.calls.filter((a) => /actions\/runs/.test(a[1])).length;
  assert.equal((await u.run()).status, "current");
  clock += 60 * 60 * 1000;
  assert.equal((await u.run()).status, "later");
  assert.equal(looks(), 1);
  assert.equal((await u.run({ force: true })).status, "current");
  clock += 24 * 60 * 60 * 1000;
  assert.equal((await u.run()).status, "current");
  assert.equal(looks(), 3);
});

test("every check on the bump PR passed, the launcher's included: it's merged", async () => {
  const repos = makeRepos();
  const gh = fakeGh({ runs: [NEW], prChecks: PR_GREEN });
  const { u, notices } = updater(repos, gh, { state: OPEN_PR });
  await u.run();
  assert.deepEqual(merges(gh.calls), [["pr", "merge", "71", "--merge", `--match-head-commit=${HEAD}`]]);
  assert.equal(u.status().tried[NEW].state, "merged");
  assert.match(notices[0].text, /merged #71/);
  assert.equal(notices[0].url, "https://github.com/x/y/pull/71");
});

test("pending, skipped, a missing launcher check or unknown mergeability: it waits", async () => {
  for (const [label, ghOptions] of [
    ["pending", { prChecks: [...PR_GREEN, run("Analyze (csharp)", null, "in_progress")] }],
    ["skipped", { prChecks: [...PR_GREEN, run("CodeQL", "skipped")] }],
    ["launcher check missing", { prChecks: PR_GREEN.filter((c) => c.name !== LAUNCHER_CHECK) }],
    ["mergeable unknown", { prChecks: PR_GREEN, mergeable: "UNKNOWN" }],
  ]) {
    const repos = makeRepos();
    const gh = fakeGh(ghOptions);
    const { u, notices } = updater(repos, gh, { state: OPEN_PR });
    const result = await u.run();
    assert.equal(result.status, "waiting", label);
    assert.deepEqual(merges(gh.calls), [], label);
    assert.deepEqual(notices, [], label);
    assert.equal(u.status().tried[NEW].state, "open", label);
  }
});

test("still waiting after a day: one notice naming what it waits on; after two days it's closed and the next bump goes", async () => {
  const repos = makeRepos();
  const opened = Date.parse("2026-10-01T00:00:00Z");
  let clock = opened + 25 * 60 * 60 * 1000;
  const pending = [...PR_GREEN, run("Analyze (csharp)", null, "queued")];
  const gh = fakeGh({ runs: [OLDER], prChecks: pending, createdAt: new Date(opened).toISOString() });
  const { u, notices } = updater(repos, gh, { state: OPEN_PR, now: () => clock });
  assert.equal((await u.run()).status, "waiting");
  assert.deepEqual(notices, [{ text: "Folio update #71 has been waiting 24h on Analyze (csharp) (queued).", url: "https://github.com/x/y/pull/71" }]);
  clock += 60 * 60 * 1000;
  assert.equal((await u.run()).status, "waiting");
  assert.equal(notices.length, 1, "one notice");
  assert.deepEqual(writes(gh.calls), []);

  clock = opened + 49 * 60 * 60 * 1000;
  const result = await u.run();
  const closed = gh.calls.find((a) => a[0] === "pr" && a[1] === "close");
  assert.equal(closed[2], "71");
  assert.match(closed[closed.indexOf("--comment") + 1], /waited two days on Analyze \(csharp\) \(queued\)/);
  assert.equal(u.status().tried[NEW].state, "expired");
  assert.equal(result.status, "opened", "the next bump goes");
  assert.equal(result.sha, OLDER);
  assert.deepEqual(merges(gh.calls), []);
});

test("a failed check on the bump PR: a notice with its link, no merge, never retried", async () => {
  const repos = makeRepos();
  const gh = fakeGh({ prChecks: [run(LAUNCHER_CHECK, "failure"), run("Node tests (full suite)")] });
  const { u, notices } = updater(repos, gh, { state: OPEN_PR });
  const result = await u.run();
  assert.equal(result.status, "tried");
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, new RegExp(`#71.*failed: ${LAUNCHER_CHECK} \\(failure\\)`));
  assert.equal(notices[0].url, `https://ci/${LAUNCHER_CHECK}`);
  assert.equal(u.status().tried[NEW].state, "failed");
  assert.deepEqual(writes(gh.calls), [], "not merged, not retried");

  const again = await u.run({ force: true });
  assert.equal(again.status, "tried");
  assert.equal(notices.length, 1, "one notice");
});

test("through the approval setting: the PR and its merge each ask first", async () => {
  const repos = makeRepos();
  const gh = fakeGh();
  const { u, gate } = updater(repos, gh, { mode: "ask" });
  assert.equal((await u.run()).status, "pending");
  assert.deepEqual(writes(gh.calls), [], "nothing before I allow it");
  assert.equal((await u.run({ force: true })).status, "pending", "asked once");
  const [request] = gate.listPending();
  assert.equal(gate.listPending().length, 1);
  assert.equal((await gate.decide(request.id, "allow-once")).status, "approved");
  assert.ok(gh.calls.some((a) => a[0] === "pr" && a[1] === "create"));
  assert.ok(git(repos.origin, "branch", "--list", `folio/${NEW.slice(0, 12)}`));

  const green = fakeGh({ prChecks: PR_GREEN });
  const { u: later, gate: gate2 } = updater(repos, green, { mode: "ask" });
  await later.run();
  assert.deepEqual(merges(green.calls), [], "the merge asks too");
  const [mergeRequest] = gate2.listPending();
  assert.match(mergeRequest.summary, /^Merge #71/);
  await gate2.decide(mergeRequest.id, "allow-once");
  assert.equal(merges(green.calls).length, 1);
});

test("the routes need my admin key, and Check now looks at Folio now", async () => {
  const { createApp } = require("../server");
  const { withServer, useTestAdminToken } = require("./helpers");
  const fetchAsAdmin = useTestAdminToken();
  const calls = [];
  const fake = {
    run: async (opts) => (calls.push(opts), { status: "current" }),
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
  assert.deepEqual(calls, [{ force: true }, false]);
});
