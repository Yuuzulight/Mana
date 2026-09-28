const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  loadSessionSummaries,
  runCompactorStage,
  runConnectionsStage,
  mergeUnique,
  reviewPlan,
} = require("../dream-mode");

const now = () => "2026-09-29T00:00:00.000Z";

function fakeModel(reply) {
  const prompts = [];
  const fn = async (prompt) => {
    prompts.push(prompt);
    return typeof reply === "function" ? reply(prompt) : reply;
  };
  fn.prompts = prompts;
  return fn;
}

const files = (n, start = 0) =>
  Array.from({ length: n }, (_, i) => ({
    file: `s${start + i}.json`,
    summary: `summary ${start + i}`,
    mtime: 1000 + start + i,
  }));

test("compactor: first run summarizes everything; with no new sessions it makes no model call; with one it merges only that one (issue #673)", async () => {
  const meta = { files: {} };
  const summarize = fakeModel("everything so far");
  const first = await runCompactorStage({ processedFiles: files(3), meta, summarize, maxChars: 2000, now });
  assert.equal(first.text, "everything so far");
  assert.equal(summarize.prompts.length, 1);
  assert.match(summarize.prompts[0], /summary 0[\s\S]*summary 2/);
  assert.equal(meta.cursors.compactor.mtime, 1002);

  const again = await runCompactorStage({ processedFiles: files(3), meta, summarize, maxChars: 2000, now });
  assert.equal(again.called, false);
  assert.equal(again.text, "everything so far");
  assert.equal(summarize.prompts.length, 1);

  const oneNew = [{ file: "s9.json", summary: "the user adopted a cat", mtime: 2000 }, ...files(3)];
  const merged = await runCompactorStage({
    processedFiles: oneNew, meta, summarize: fakeModel("everything so far, plus a cat"), maxChars: 2000, now,
  });
  assert.equal(merged.incremental, true);
  assert.equal(merged.summarized, 1);
  assert.equal(meta.lastCompacted.text, "everything so far, plus a cat");
  assert.equal(meta.cursors.compactor.mtime, 2000);
});

test("compactor: the merge prompt carries the previous block and only the new summary", async () => {
  const meta = { files: {}, lastCompacted: { text: "old block" }, cursors: { compactor: { mtime: 1002 } } };
  const summarize = fakeModel("new block");
  await runCompactorStage({
    processedFiles: [{ file: "s9.json", summary: "brand new", mtime: 1003 }, ...files(3)],
    meta, summarize, maxChars: 2000, now,
  });
  assert.match(summarize.prompts[0], /CURRENT BACKGROUND MEMORY:\nold block/);
  assert.match(summarize.prompts[0], /brand new/);
  assert.doesNotMatch(summarize.prompts[0], /summary 0/);
});

test("compactor: meta from before #673 with an unchanged hash just gains a cursor, no model call; a failed call leaves the cursor alone", async () => {
  const processedFiles = files(2);
  const crypto = require("node:crypto");
  const hash = crypto.createHash("sha1").update("summary 0\n\nsummary 1").digest("hex");
  const meta = { files: {}, lastCompacted: { hash, text: "kept" } };
  const summarize = fakeModel("unused");
  const result = await runCompactorStage({ processedFiles, meta, summarize, maxChars: 2000, now });
  assert.equal(result.called, false);
  assert.equal(result.text, "kept");
  assert.equal(summarize.prompts.length, 0);
  assert.equal(meta.cursors.compactor.mtime, 1001);

  const failing = { files: {} };
  const none = await runCompactorStage({ processedFiles, meta: failing, summarize: fakeModel(null), maxChars: 2000, now });
  assert.equal(none.text, null);
  assert.equal(failing.cursors, undefined);
});

test("connections: no new summaries -> no model call; new ones are marked, compared against existing ones, and merged ahead of earlier connections (issue #673)", async () => {
  const meta = { files: {}, connections: ["Summary #1 <-> Summary #2: from an old prompt"] };
  const ask = fakeModel("Cats: came up twice");
  const first = await runConnectionsStage({ processedFiles: files(3), meta, ask, maxSummaries: 30, minSummaries: 2, now });
  assert.equal(first.ok, true);
  // First run with a cursor replaces pre-#673 numbered lines.
  assert.deepEqual(meta.connections, ["Cats: came up twice"]);

  const idle = await runConnectionsStage({ processedFiles: files(3), meta, ask, maxSummaries: 30, minSummaries: 2, now });
  assert.deepEqual(idle, { ok: false, reason: "no_new_summaries" });
  assert.equal(ask.prompts.length, 1);

  const ask2 = fakeModel("Dogs: new walk routine follows up on last week\nCats: came up twice");
  await runConnectionsStage({
    processedFiles: [{ file: "s9.json", summary: "dog walks", mtime: 5000 }, ...files(3)],
    meta, ask: ask2, maxSummaries: 30, minSummaries: 2, now,
  });
  assert.match(ask2.prompts[0], /1\. \[new\] \[session: s9\.json\] dog walks/);
  assert.match(ask2.prompts[0], /2\. \[session: s0\.json\]/);
  assert.deepEqual(meta.connections, ["Dogs: new walk routine follows up on last week", "Cats: came up twice"]);
});

test("reviewer: a scheduled run is skipped when nothing is new, and runs when a summary was added (issue #673)", () => {
  const meta = {};
  const plan = reviewPlan({ processedFiles: files(3), meta, skipIfUnchanged: true });
  assert.equal(plan.skip, false);
  meta.lastReviewedHash = plan.hash;
  assert.equal(reviewPlan({ processedFiles: files(3), meta, skipIfUnchanged: true }).skip, true);
  assert.equal(reviewPlan({ processedFiles: files(3), meta, skipIfUnchanged: false }).skip, false);
  assert.equal(reviewPlan({ processedFiles: files(4), meta, skipIfUnchanged: true }).skip, false);
});

test("important facts are merged newest first without duplicates instead of replaced (issue #673)", () => {
  assert.deepEqual(
    mergeUnique(["Likes tea", "Has a cat", { not: "a string" }], ["has a cat", "Works nights"], 200),
    ["Likes tea", "Has a cat", "Works nights"],
  );
  assert.deepEqual(mergeUnique(["a", "b", "c"], [], 2), ["a", "b"]);
});

test("a pruned summary stays pruned across reloads until its session changes (issue #673 regression)", async () => {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-dream-"));
  fs.writeFileSync(path.join(sessionsDir, "a.json"), JSON.stringify({ summary: "keep me" }));
  fs.writeFileSync(path.join(sessionsDir, "b.json"), JSON.stringify({ summary: "trivial chatter" }));
  const meta = { files: {} };
  const first = await loadSessionSummaries({ sessionsDir, meta, maxFiles: 200 });
  assert.equal(first.summaries.length, 2);

  // What the reviewer does to a pruned entry.
  meta.files["b.json"].pruned = true;
  meta.files["b.json"].summary = "";
  for (let i = 0; i < 2; i += 1) {
    const reload = await loadSessionSummaries({ sessionsDir, meta, maxFiles: 200 });
    assert.deepEqual(reload.summaries, ["keep me"]);
    assert.equal(meta.files["b.json"].pruned, true);
  }

  // The session changing un-prunes it.
  const later = new Date(Date.now() + 60000);
  fs.writeFileSync(path.join(sessionsDir, "b.json"), JSON.stringify({ summary: "now it matters" }));
  fs.utimesSync(path.join(sessionsDir, "b.json"), later, later);
  const changed = await loadSessionSummaries({ sessionsDir, meta, maxFiles: 200 });
  assert.ok(changed.summaries.includes("now it matters"));
  assert.equal(meta.files["b.json"].pruned, undefined);
});

test("compactor: a session that was folded in and is now gone forces a full rebuild instead of lingering in the block", async () => {
  const meta = { files: {} };
  await runCompactorStage({ processedFiles: files(3), meta, summarize: fakeModel("all three"), maxChars: 2000, now });
  assert.deepEqual(meta.cursors.compactor.files, ["s0.json", "s1.json", "s2.json"]);
  const summarize = fakeModel("only two left");
  const result = await runCompactorStage({ processedFiles: files(2), meta, summarize, maxChars: 2000, now });
  assert.equal(result.incremental, false);
  assert.match(summarize.prompts[0], /BEGIN SUMMARIES:\nsummary 0\n\nsummary 1\n/);
  assert.equal(meta.lastCompacted.text, "only two left");
});
