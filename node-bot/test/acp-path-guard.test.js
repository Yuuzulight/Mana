const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { isInsideRoot } = require("../acp-path-guard");

// A root with a file, and a junction (a symlink off Windows) to a folder
// outside it. rmSync doesn't follow the link, so cleanup stays in base.
function tempTree(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mana-path-guard-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, "src", "a.js"), "");
  fs.writeFileSync(path.join(outside, "secret.txt"), "");
  fs.symlinkSync(outside, path.join(root, "link"), "junction");
  return { base, root };
}

test("isInsideRoot allows the root and paths under it", (t) => {
  const { root } = tempTree(t);
  assert.equal(isInsideRoot(root, root), true);
  assert.equal(isInsideRoot(path.join(root, "src", "a.js"), root), true);
  assert.equal(isInsideRoot(path.join(root, "src", "new.js"), root), true);
  assert.equal(isInsideRoot(path.join(root, "..name.js"), root), true);
});

test("isInsideRoot refuses parents, siblings with a shared prefix, and other roots", (t) => {
  const { base, root } = tempTree(t);
  assert.equal(isInsideRoot(path.join(root, "..", "outside", "secret.txt"), root), false);
  assert.equal(isInsideRoot(`${root}2${path.sep}x.js`, root), false);
  assert.equal(isInsideRoot(base, root), false);
});

test("isInsideRoot refuses a junction that leads out, however it's spelled", (t) => {
  const { root } = tempTree(t);
  assert.equal(isInsideRoot(path.join(root, "link", "secret.txt"), root), false);
  assert.equal(isInsideRoot(path.join(root, "link", "new.txt"), root), false);
  assert.equal(isInsideRoot(path.join(root, "link.", "secret.txt"), root), false);
});

test("isInsideRoot matches Windows case-insensitively", { skip: process.platform !== "win32" }, (t) => {
  const { root } = tempTree(t);
  assert.equal(isInsideRoot(path.join(root.toUpperCase(), "SRC", "A.JS"), root), true);
  assert.equal(isInsideRoot(path.join(root, "LINK", "secret.txt"), root.toUpperCase()), false);
});
