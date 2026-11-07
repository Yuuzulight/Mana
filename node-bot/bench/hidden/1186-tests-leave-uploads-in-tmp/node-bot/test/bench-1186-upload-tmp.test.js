// #1221 bench case for #1186: the upload tests pass and write nothing into
// node-bot/tmp. #1467: watched while they run, not just listed before and
// after -- at the base most of them remove their upload when done, so the
// listing alone passed without a fix.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawn } = require("node:child_process");

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

test("#1186: the upload tests write nothing into node-bot/tmp", async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const before = list();
  const written = new Set();
  const watcher = fs.watch(DIR, (event, name) => {
    if (name) written.add(String(name));
  });
  // A fresh run, as if started by hand, not as a child of this one.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.MANA_UPLOAD_TMP_DIR;
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", ...FILES], { cwd: NODE_BOT, env, windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
  // Let the last directory events arrive.
  await new Promise((resolve) => setTimeout(resolve, 500));
  watcher.close();
  assert.equal(r.code, 0, r.out.slice(-3000));
  assert.deepEqual([...written].sort(), [], "files were written into node-bot/tmp (even if removed after)");
  assert.deepEqual(list(), before);
});
