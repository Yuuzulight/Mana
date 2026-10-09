// #1221 bench case for #1186: the upload tests pass and leave node-bot/tmp
// as it was.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const NODE_BOT = path.join(__dirname, "..");
const DIR = path.join(NODE_BOT, "tmp");
const FILES = [
  "test/mobile-routes.test.js",
  "test/plugin-input-hooks-routes.test.js",
  "test/server-routes.test.js",
  "test/transcribe-partial-real-whisper.test.js",
  "test/transcribe-partial-route.test.js",
  "test/voice-upload-cleanup.test.js",
];
const list = () => (fs.existsSync(DIR) ? fs.readdirSync(DIR).sort() : []);

test("#1186: the upload tests leave node-bot/tmp unchanged", () => {
  const before = list();
  // A fresh run, as if started by hand, not as a child of this one.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.MANA_UPLOAD_TMP_DIR;
  const r = spawnSync(process.execPath, ["--test", ...FILES], { cwd: NODE_BOT, env, encoding: "utf8", windowsHide: true });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`.slice(-3000));
  assert.deepEqual(list(), before);
});
