// #1407: behaviour evals once per deployed merge of hers; a failed gate holds the issue.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createLifecycle } = require("../self-improvement");
const { createPostDeployEval, latestBaseline } = require("../post-deploy-eval");

function setup({ gate = { passed: true }, code = 0, blocked = null, head = "abc12345ff", deployed = "m900" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-postdeploy-"));
  const resultsDir = path.join(dir, "results");
  const life = createLifecycle({ file: path.join(dir, "life.json") });
  life.onRunEnd({ issue: 42, title: "Fix the tray icon", state: "pr-open", prUrl: "https://github.com/x/y/pull/900" });
  life.onMerged({ number: 900, headRefName: "mana/42-fix-the-tray-icon", mergeCommit: { oid: "m900" } });
  const runs = [];
  const notes = [];
  const git = async (args) => {
    if (args[0] === "rev-parse") return head;
    if (args[1] === "--is-ancestor" && args[2] === deployed) return "";
    throw new Error("not an ancestor");
  };
  const run = async (o) => {
    runs.push(o);
    if (code !== 2) {
      fs.mkdirSync(path.join(resultsDir, o.label), { recursive: true });
      fs.writeFileSync(path.join(resultsDir, o.label, "report.json"), JSON.stringify({ scenarios: [], gate }));
    }
    return code;
  };
  const evals = createPostDeployEval({ lifecycle: life, stateFile: path.join(dir, "state.json"), blocked: async () => blocked, notify: (t) => notes.push(t), run, git, resultsDir });
  const settle = async () => {
    while (evals.running()) await new Promise((r) => setImmediate(r));
  };
  return { life, evals, runs, notes, settle, resultsDir };
}

test("a deployed merge is evaluated once and verified", async () => {
  const s = setup();
  assert.equal(await s.evals.maybeRun(), true);
  await s.settle();
  assert.deepEqual(s.runs.map((r) => [r.label, r.baseline]), [["post-deploy-abc12345", null]]);
  assert.equal(s.life.get(42).state, "verified");
  assert.equal(await s.evals.maybeRun(), false, "same deployed head: not again");
  assert.equal(s.runs.length, 1);
  assert.deepEqual(s.notes, []);
  // That passing report is the next run's baseline.
  assert.match(latestBaseline(s.resultsDir), /post-deploy-abc12345[\\/]report\.json$/);
});

test("a failed gate holds the issue and tells me; nothing reverts", async () => {
  const s = setup({ gate: { passed: false, failures: ["recall-across-chats: worse than the baseline"] }, code: 1 });
  await s.evals.maybeRun();
  await s.settle();
  assert.equal(s.life.get(42).state, "regressed");
  assert.match(s.life.skip(42), /recall-across-chats/);
  assert.match(s.notes[0], /got worse after deploying #900: recall-across-chats.*held #42.*Nothing was reverted/);
});

test("blocked or not deployed: no run, so her idle work goes ahead", async () => {
  const s = setup({ blocked: "a game is running" });
  assert.equal(await s.evals.maybeRun(), false);
  const t = setup({ deployed: "something-else" });
  assert.equal(await t.evals.maybeRun(), false);
  assert.equal(s.runs.length + t.runs.length, 0);
  assert.equal(t.life.get(42).state, "merged");
});

test("an eval that can't run is retried a few times, then I'm told", async () => {
  const s = setup({ code: 2 });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(await s.evals.maybeRun(), true);
    await s.settle();
  }
  assert.equal(await s.evals.maybeRun(), false);
  assert.equal(s.runs.length, 3);
  assert.equal(s.life.get(42).state, "merged");
  assert.match(s.notes[0], /couldn't run my behaviour evals after deploying #900 \(3 tries\)/);
});
