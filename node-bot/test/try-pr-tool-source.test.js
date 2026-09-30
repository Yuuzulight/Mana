// #1010: "let me try your PR" in the chat.
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { createTryPrToolSource, TRY_PR_TOOL, BACK_TO_MAIN_TOOL, REVERT_TOOL } = require("../ai/try-pr-tool-source");

const root = path.resolve("mana-checkout");

function source(userMessage, prs = [], revert = async () => ({ ok: false, error: "no" })) {
  const runs = [];
  const tools = createTryPrToolSource({
    userMessage,
    repoRoot: root,
    gh: async () => prs,
    run: (script, args) => runs.push({ script, args }),
    revert,
  });
  const call = (name, args) => tools.executeTool(name, args).then(JSON.parse);
  return { call, runs };
}

const script = path.join(root, "windows-native-launcher", "try-pr.ps1");

test("a PR number only from my own message", async () => {
  const { call, runs } = source("can you run PR 1020 for me?");
  assert.match((await call(TRY_PR_TOOL, { pr: 1021 })).error, /#1021 isn't in Yuuzulight's message/);
  assert.equal(runs.length, 0);
  assert.equal((await call(TRY_PR_TOOL, { pr: 1020 })).trying, 1020);
  assert.deepEqual(runs, [{ script, args: ["-Pr", "1020"] }]);
});

test("\"let me try your PR\" is her newest open PR, never someone else's", async () => {
  const prs = [
    { number: 1018, headRefName: "mana/12-a" },
    { number: 1030, headRefName: "feat/other" },
    { number: 1025, headRefName: "mana/14-b" },
  ];
  const { call, runs } = source("let me try your PR", prs);
  assert.equal((await call(TRY_PR_TOOL, {})).trying, 1025);
  assert.deepEqual(runs[0].args, ["-Pr", "1025"]);

  const none = source("let me try your PR", [{ number: 1030, headRefName: "feat/other" }]);
  assert.match((await none.call(TRY_PR_TOOL, {})).error, /no open PR/);
  assert.equal(none.runs.length, 0);
});

test("back to main", async () => {
  const { call, runs } = source("ok, back to main");
  assert.equal((await call(BACK_TO_MAIN_TOOL, {})).status, "ok");
  assert.deepEqual(runs, [{ script, args: ["-Main"] }]);
});

// #1011
test("revert: a merged PR from my message gets a revert PR, then the build rolls back", async () => {
  const reverts = [];
  const revert = async (pr, reason) => (reverts.push([pr, reason]), { ok: true, issueUrl: "i", prUrl: "p", mergeCommit: "abc123" });
  const { call, runs } = source("#1018 broke the chat, revert it", [], revert);
  assert.match((await call(REVERT_TOOL, { pr: 1019 })).error, /#1019 isn't in Yuuzulight's message/);
  assert.equal(reverts.length, 0);
  const done = await call(REVERT_TOOL, { pr: 1018, reason: "the chat broke" });
  assert.equal(done.revertPr, "p");
  assert.deepEqual(reverts, [[1018, "the chat broke"]]);
  assert.deepEqual(runs, [{ script, args: ["-Previous", "-Without", "abc123"] }]);

  const failed = source("revert #1018");
  assert.equal((await failed.call(REVERT_TOOL, { pr: 1018 })).error, "no");
  assert.equal(failed.runs.length, 0, "no rollback without a revert PR");
});
