"use strict";

// #1385: lessons from Mana's failed self-work runs.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLessons } = require("../self-work-lessons");
const { createApprovalGate } = require("../approval-gate");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mana-lessons-"));
function make(extra = {}) {
  const dir = tmp();
  const approvalGate = createApprovalGate({ dataDir: dir, guardianAuditLog: { append() {} } });
  const lessons = createLessons({ file: path.join(dir, "lessons.json"), approvalGate, env: {}, ...extra });
  return { dir, approvalGate, lessons };
}
const failed = (issue = 7, extra = {}) => ({
  issue,
  title: `Issue ${issue}`,
  attempts: [{ attempt: 1, finished: false, passed: false, failures: 2, failing: ["adds numbers"] }],
  ...extra,
});

test("a failed run without a PR leaves a record of what was observed, with her guess apart", () => {
  const { lessons } = make();
  const l = lessons.record(failed(7, { finalWords: "I think the parser is the problem." }), "not-done", "I couldn't finish #7.");
  assert.equal(l.status, "open");
  assert.equal(l.confidence, "low");
  assert.equal(l.hypothesis, "I think the parser is the problem.");
  assert.equal(l.prevention, null);
  assert.ok(l.observed.some((o) => /not-done/.test(o)));
  assert.ok(l.observed.some((o) => /Attempt 1: not finished, 2 failing \(adds numbers\)/.test(o)));
  assert.ok(l.observed.includes("No PR was opened."));
  assert.ok(!l.observed.some((o) => /parser/.test(o)), "her guess isn't an observation");
  assert.equal(lessons.list().length, 1);
});

test("states that are mine or the machine's aren't lessons; a refuted PR and a revert are", () => {
  const { lessons } = make();
  assert.equal(lessons.record(failed(), "stopped", "I stopped."), null);
  assert.equal(lessons.record(failed(), "paused", "RAM."), null);
  assert.equal(lessons.record(failed(), "pr-open", "ready"), null);
  const refuted = lessons.record(failed(8, { refuted: { path: "a.js", failingCase: "empty input" }, prUrl: "https://x/pull/9" }), "pr-open", "ready");
  assert.equal(refuted.occurrences[0].state, "pr-open-refuted");
  assert.ok(refuted.observed.some((o) => /refuted my change to a\.js: empty input/.test(o)));
  const rev = lessons.record({ issue: 9, title: "t" }, "reverted", "broke boot", { kind: "revert", pr: 12, baseCommit: "abc123" });
  assert.deepEqual(rev.occurrences[0], { at: rev.firstAt, state: "reverted", kind: "revert", pr: 12, baseCommit: "abc123" });
});

test("a second failure on the same issue adds an occurrence to the same lesson", () => {
  const { lessons } = make();
  const first = lessons.record(failed(), "not-done", "first");
  const again = lessons.record(failed(), "tests-failing", "second");
  assert.equal(again.id, first.id);
  assert.equal(lessons.list().length, 1);
  assert.deepEqual(again.occurrences.map((o) => o.state), ["not-done", "tests-failing"]);
  assert.ok(again.observed.some((o) => /second/.test(o)));
  assert.equal(again.observed.filter((o) => /Attempt 1/.test(o)).length, 1, "the same fact once");
  assert.equal(lessons.record(failed(8), "failed", "other").issue, 8);
  assert.equal(lessons.list().length, 2);
});

test("her hypothesis is never a standing rule; only an approved promotion makes one", async () => {
  const { lessons, approvalGate } = make();
  const l = lessons.record(failed(7, { finalWords: "Probably the cache." }), "not-done", "x");
  assert.deepEqual(lessons.standingRules(), []);
  const asked = await lessons.promote(l.id, "Always clear the cache first.");
  assert.equal(asked.status, "pending");
  const [req] = approvalGate.listPending();
  assert.equal(req.actionType, "self-work-lesson");
  assert.equal(req.forceReview, true);
  assert.deepEqual(req.payload, { id: l.id, rule: "Always clear the cache first." });
  assert.deepEqual(lessons.standingRules(), [], "asking isn't approving");
  // Denied: stays open, no rule.
  await approvalGate.decide(req.id, "deny");
  assert.equal(lessons.list()[0].status, "open");
  assert.deepEqual(lessons.standingRules(), []);
  // Approved: promoted with the rule I read; "always allow" can't grant it for next time.
  await lessons.promote(l.id, "Always clear the cache first.");
  await approvalGate.decide(approvalGate.listPending()[0].id, "always-allow");
  assert.equal(lessons.list()[0].status, "promoted");
  assert.deepEqual(lessons.standingRules(), ["Always clear the cache first."]);
  assert.equal((await lessons.promote(l.id, "again")).ok, false, "only an open lesson");
  const l2 = lessons.record(failed(8), "failed", "y");
  assert.equal((await lessons.promote(l2.id, "Another rule.")).status, "pending", "no grant from the last approval");
});

test("a superseded lesson is kept but not retrieved, and its rule stops standing", async () => {
  const { lessons, approvalGate } = make();
  const a = lessons.record(failed(7), "not-done", "old");
  const b = lessons.record(failed(8), "not-done", "new");
  assert.match(lessons.forIssue(7), /old/);
  assert.deepEqual(lessons.supersede(a.id, b.id), { ok: true });
  assert.equal(lessons.forIssue(7), "");
  assert.equal(lessons.list().find((x) => x.id === a.id).supersededBy, b.id);
  assert.equal(lessons.supersede(a.id, "nope").ok, false);
  await lessons.promote(b.id, "A rule.");
  await approvalGate.decide(approvalGate.listPending()[0].id, "allow-once");
  lessons.supersede(b.id, a.id);
  assert.deepEqual(lessons.standingRules(), []);
  assert.equal(lessons.list().length, 2);
});

test("secrets, tokens and local paths in run text are redacted before anything is stored", () => {
  const { dir, lessons } = make({ env: { DISCORD_TOKEN: "super-secret-token-value" } });
  lessons.record(
    failed(7, { finalWords: "key ghp_abcdefghijklmnopqrstuvwxyz0123456789 was bad", refuted: { path: "a.js", failingCase: "leaks super-secret-token-value" } }),
    "failed",
    "crash in C:\\Users\\me\\secret.txt with Bearer abcdefghijklmnopqrstuvwxyz",
  );
  const text = fs.readFileSync(path.join(dir, "lessons.json"), "utf8");
  assert.doesNotMatch(text, /super-secret-token-value|ghp_abc|Users|abcdefghijklmnopqrstuvwxyz/);
});

test("retention drops the oldest lessons that aren't promoted; promoted ones stay", async () => {
  const { lessons, approvalGate } = make({ max: 3 });
  const first = lessons.record(failed(1), "failed", "a");
  await lessons.promote(first.id, "Keep me.");
  await approvalGate.decide(approvalGate.listPending()[0].id, "allow-once");
  for (const n of [2, 3, 4, 5]) lessons.record(failed(n), "failed", "x");
  assert.deepEqual(lessons.list().map((l) => l.issue), [1, 4, 5]);
});

test("what planning gets is the same issue's or the same files' open lessons, bounded", () => {
  const { lessons } = make();
  lessons.record(failed(7, { finalWords: "guess" }), "not-done", "see node-bot/util.js " + "long ".repeat(200));
  lessons.record(failed(8), "failed", "touched node-bot/util.js");
  lessons.record(failed(9), "failed", "unrelated thing");
  const own = lessons.forIssue(7);
  assert.match(own, /^- #7: earlier runs on this: observed - /);
  assert.match(own, /my guess then \(unverified\) - guess/);
  assert.doesNotMatch(own, /#8|#9/);
  const byFile = lessons.forIssue(20, ["node-bot/util.js"]);
  assert.match(byFile, /#7/);
  assert.match(byFile, /#8/);
  assert.doesNotMatch(byFile, /#9/);
  for (let n = 30; n < 45; n++) lessons.record(failed(n), "failed", "node-bot/util.js " + "pad ".repeat(100));
  const bounded = lessons.forIssue(20, ["node-bot/util.js"]);
  assert.ok(bounded.length <= 1200, `${bounded.length}`);
  assert.ok(bounded.split("\n").length <= 5);
});
