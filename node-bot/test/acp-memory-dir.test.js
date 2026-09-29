// MANA_ACP_MEMORY_DIR moves all of memory, the graph and search databases
// included -- and run_tests.js points it at a temp dir, so a test run never
// writes fixture sessions into node-bot/data/acp-memory.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const nodeBotDir = path.join(__dirname, "..");

test("MANA_ACP_MEMORY_DIR moves the memory graph and session search databases too", () => {
  const dir = path.join(os.tmpdir(), "mana-acp-memory-dir-test");
  const out = execFileSync(
    process.execPath,
    [
      "-e",
      "console.log(JSON.stringify([require('./memory-graph').DEFAULT_DB_PATH, require('./session-search-index').DEFAULT_DB_PATH]))",
    ],
    { cwd: nodeBotDir, env: { ...process.env, MANA_ACP_MEMORY_DIR: dir }, encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(out), [path.join(dir, "memory-graph.db"), path.join(dir, "session-search.db")]);
});

test("under run_tests.js, memory lives outside node-bot/data", { skip: !process.env.MANA_ACP_MEMORY_DIR }, () => {
  const real = path.join(nodeBotDir, "data", "acp-memory");
  assert.notEqual(path.resolve(process.env.MANA_ACP_MEMORY_DIR), path.resolve(real));
  assert.equal(require("../memory-graph").DEFAULT_DB_PATH.startsWith(real), false);
});
