const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  createAcpPathGuard,
  parseAllowedPathList,
} = require("../acp-path-guard");

test("parseAllowedPathList splits Windows semicolon separated roots", () => {
  assert.deepEqual(
    parseAllowedPathList("C:\\ManaAI\\Mana;D:\\Shared", "win32"),
    [path.resolve("C:\\ManaAI\\Mana"), path.resolve("D:\\Shared")],
  );
});

test("path guard allows active workspace files", () => {
  const workspace = path.join("C:", "ManaAI", "Mana");
  const guard = createAcpPathGuard({
    workspacePath: workspace,
    allowedPaths: "",
    platform: "win32",
  });

  const checked = guard.resolveAllowedPath("node-bot/server.js");

  assert.equal(checked.allowed, true);
  assert.equal(
    checked.fullPath,
    path.resolve(workspace, "node-bot/server.js"),
  );
  assert.equal(checked.rootType, "workspace");
});

test("path guard rejects outside paths by default", () => {
  const guard = createAcpPathGuard({
    workspacePath: path.join("C:", "ManaAI", "Mana"),
    allowedPaths: "",
    platform: "win32",
  });

  assert.throws(
    () => guard.resolveAllowedPath(path.join("D:", "Shared", "note.txt")),
    /path is outside the active workspace and allowed roots/i,
  );
});

test("path guard allows outside paths under configured roots", () => {
  const externalRoot = path.join("D:", "Shared");
  const guard = createAcpPathGuard({
    workspacePath: path.join("C:", "ManaAI", "Mana"),
    allowedPaths: externalRoot,
    platform: "win32",
  });

  const checked = guard.resolveAllowedPath(path.join(externalRoot, "note.txt"));

  assert.equal(checked.allowed, true);
  assert.equal(checked.rootType, "allowed");
  assert.equal(checked.rootPath, path.resolve(externalRoot));
});

test("path guard rejects sibling paths with a shared prefix", () => {
  const guard = createAcpPathGuard({
    workspacePath: path.join("C:", "ManaAI", "Mana"),
    allowedPaths: path.join("C:", "ManaAI", "ManaTools"),
    platform: "win32",
  });

  assert.throws(
    () => guard.resolveAllowedPath(path.join("C:", "ManaAI", "ManaTools2", "x.js")),
    /path is outside the active workspace and allowed roots/i,
  );
});
