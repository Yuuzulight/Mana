// #1221 bench case for #1187: the pending-writes tests pass and leave
// node-bot/data/pending_writes as it was.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const NODE_BOT = path.join(__dirname, "..");
const DIR = path.join(NODE_BOT, "data", "pending_writes");
const FILES = ["test/admin-accounts-routes.test.js", "test/pending-writes-path-safety.test.js"];
const list = () => (fs.existsSync(DIR) ? fs.readdirSync(DIR).sort() : []);

test("#1187: the pending-writes tests leave data/pending_writes unchanged", () => {
  const before = list();
  // A fresh run, as if started by hand, not as a child of this one.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.MANA_PENDING_WRITES_DIR;
  const r = spawnSync(process.execPath, ["--test", ...FILES], { cwd: NODE_BOT, env, encoding: "utf8", windowsHide: true });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`.slice(-3000));
  assert.deepEqual(list(), before);
});
