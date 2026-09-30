// #1010: "let me try your PR" in the chat.
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { createTryPrToolSource, TRY_PR_TOOL, BACK_TO_MAIN_TOOL } = require("../ai/try-pr-tool-source");

function source(userMessage, prs = []) {
  const runs = [];
  const tools = createTryPrToolSource({
    userMessage,
    repoRoot: "D:\Mana",
    gh: async () => prs,
    run: (script, args) => runs.push({ script, args }),
  });
  const call = (name, args) => tools.executeTool(name, args).then(JSON.parse);
  return { call, runs };
}

const script = path.join("D:\Mana", "windows-native-launcher", "try-pr.ps1");

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
