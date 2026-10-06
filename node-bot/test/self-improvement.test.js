// #1386: her improvement lifecycle -- states with evidence, a retry budget,
// holds the idle picker respects, and nothing lost across a restart.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

process.env.MANA_ACP_MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mana-lifecycle-"));

const { createLifecycle } = require("../self-improvement");

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mana-lifecycle-")), "self-improvement.json");
const run = (state, extra = {}) => ({ issue: 42, title: "Fix the tray icon", state, step: `ended ${state}`, ...extra });

test("failures use up the budget, then the issue is held and the idle picker skips it", () => {
  const life = createLifecycle({ file: tmpFile() });
  life.onRunEnd(run("tests-failing"));
  assert.equal(life.get(42).state, "retry");
  assert.equal(life.skip(42), null);
  // A game pause or my stop doesn't count.
  life.onRunEnd(run("paused"));
  life.onRunEnd(run("stopped"));
  assert.equal(life.get(42).attempts, 1);
  life.onRunEnd(run("failed", { step: "I hit a problem and stopped: boom" }));
  const r = life.get(42);
  assert.equal(r.state, "exhausted");
  assert.match(r.history.at(-1).why, /tried 2 times; last: I hit a problem/);
  assert.match(life.skip(42), /^exhausted/);
  // I ask for another try: the hold and budget clear.
  life.retry(42);
  assert.equal(life.skip(42), null);
  assert.equal(life.get(42).attempts, 0);
});

test("a PR, needs-you and the transitions are kept with their evidence", () => {
  const life = createLifecycle({ file: tmpFile() });
  life.onRunEnd(run("pr-open", { prUrl: "https://github.com/Yuuzulight/Mana/pull/900" }));
  assert.deepEqual([life.get(42).state, life.get(42).prs], ["pr-open", [900]]);
  life.onRunEnd(run("needs-you", { step: "my reviewer refuted the same file three times" }));
  assert.match(life.skip(42), /^needs-you: my reviewer refuted/);
  assert.deepEqual(life.get(42).history.map((h) => h.state), ["pr-open", "needs-you"]);
});

test("merged, then verified or regressed by an evaluation gate", () => {
  const life = createLifecycle({ file: tmpFile() });
  life.onRunEnd(run("pr-open", { prUrl: "https://github.com/x/y/pull/900" }));
  life.onMerged({ number: 900, headRefName: "mana/42-fix-the-tray-icon" });
  assert.equal(life.get(42).state, "merged");
  life.verify(42, { label: "behavior-x" });
  assert.equal(life.get(42).state, "merged", "a report without a gate changes nothing");
  life.verify(42, { label: "behavior-y", gate: { passed: false, failures: ["recall-across-chats: worse than the baseline"] } });
  assert.equal(life.get(42).state, "regressed");
  assert.match(life.skip(42), /recall-across-chats/);
  // Merged again later (it's still in the merged list) doesn't undo the verdict.
  life.onMerged({ number: 900, headRefName: "mana/42-fix-the-tray-icon" });
  assert.equal(life.get(42).state, "regressed");
  life.retry(42);
  life.verify(42, { gate: { passed: true } });
  assert.equal(life.get(42).state, "verified");
  // Not hers: ignored.
  assert.equal(life.onMerged({ number: 5, headRefName: "feat/other" }), null);
});

test("state survives a restart; a broken file starts fresh instead of stopping her", () => {
  const file = tmpFile();
  createLifecycle({ file }).onRunEnd(run("tests-failing"));
  const again = createLifecycle({ file });
  assert.equal(again.get(42).attempts, 1);
  again.onRunEnd(run("tests-failing"));
  assert.equal(again.get(42).state, "exhausted");
  fs.writeFileSync(file, "{ broken");
  assert.deepEqual(createLifecycle({ file }).list(), []);
});

test("retention keeps held records and drops the oldest finished ones", () => {
  let t = 0;
  const life = createLifecycle({ file: tmpFile(), now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)).toISOString() });
  life.onRunEnd({ issue: 1, state: "needs-you", step: "held" });
  for (let i = 2; i <= 205; i += 1) life.onRunEnd({ issue: i, state: "no-change", step: "x" });
  assert.equal(life.list().length, 200);
  assert.ok(life.get(1), "held record kept");
  assert.equal(life.get(2), null, "oldest finished one dropped");
});

test("routes list records, clear a hold and verify only from a bench/results report", async () => {
  const { createApp } = require("../server");
  const { useTestAdminToken, withServer } = require("./helpers");
  const fetch = useTestAdminToken();
  const life = createLifecycle({ file: tmpFile() });
  life.onRunEnd(run("needs-you"));
  const app = createApp({ selfImprovement: life });
  await withServer(app, async (base) => {
    const list = await (await fetch(`${base}/self-improvement`)).json();
    assert.equal(list.records[0].issue, 42);
    const retried = await (await fetch(`${base}/self-improvement/42/retry`, { method: "POST" })).json();
    assert.equal(retried.record.state, "retry");
    const bad = await fetch(`${base}/self-improvement/42/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "../../etc" }),
    });
    assert.equal(bad.status, 400);
  });
});
