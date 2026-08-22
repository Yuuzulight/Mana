const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createScratchWorkspaceCopy,
  removeScratchWorkspaceCopy,
  findNodeModulesDirs,
} = require("../workspace-scratch-copy");

function makeFixtureWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mana-scratch-fixture-"));
  fs.writeFileSync(path.join(root, "app.js"), "module.exports = 1;\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "index.js"), "console.log('hi');\n");
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.mkdirSync(path.join(root, "node_modules", "some-dep"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "some-dep", "index.js"), "module.exports = {};\n");
  return root;
}

test("createScratchWorkspaceCopy copies real files, excludes .git, and junctions node_modules", () => {
  const source = makeFixtureWorkspace();
  let scratchDir;
  try {
    scratchDir = createScratchWorkspaceCopy(source);

    assert.equal(fs.readFileSync(path.join(scratchDir, "app.js"), "utf8"), "module.exports = 1;\n");
    assert.equal(
      fs.readFileSync(path.join(scratchDir, "src", "index.js"), "utf8"),
      "console.log('hi');\n",
    );
    assert.equal(fs.existsSync(path.join(scratchDir, ".git")), false, ".git must not be copied");

    // node_modules is junctioned, not copied -- confirm it's a symlink
    // (junction), not a regular directory, and that it actually resolves
    // to the real dependency.
    const stat = fs.lstatSync(path.join(scratchDir, "node_modules"));
    assert.equal(stat.isSymbolicLink(), true);
    assert.equal(
      fs.readFileSync(path.join(scratchDir, "node_modules", "some-dep", "index.js"), "utf8"),
      "module.exports = {};\n",
    );
  } finally {
    if (scratchDir) removeScratchWorkspaceCopy(scratchDir);
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test("a scratch copy is independent of the source -- writing into it does not touch the original", () => {
  const source = makeFixtureWorkspace();
  let scratchDir;
  try {
    scratchDir = createScratchWorkspaceCopy(source);
    fs.writeFileSync(path.join(scratchDir, "app.js"), "mutated by a test run\n");

    assert.equal(
      fs.readFileSync(path.join(source, "app.js"), "utf8"),
      "module.exports = 1;\n",
      "the real workspace file must be untouched",
    );
  } finally {
    if (scratchDir) removeScratchWorkspaceCopy(scratchDir);
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test("removeScratchWorkspaceCopy deletes the scratch copy but never the real node_modules it junctions to", () => {
  const source = makeFixtureWorkspace();
  const scratchDir = createScratchWorkspaceCopy(source);

  removeScratchWorkspaceCopy(scratchDir);

  assert.equal(fs.existsSync(scratchDir), false, "the scratch dir itself should be gone");
  assert.equal(
    fs.readFileSync(path.join(source, "node_modules", "some-dep", "index.js"), "utf8"),
    "module.exports = {};\n",
    "the real node_modules content must survive removing the scratch copy's junction to it",
  );

  fs.rmSync(source, { recursive: true, force: true });
});

test("removeScratchWorkspaceCopy does not throw for a path that does not exist", () => {
  assert.doesNotThrow(() => {
    removeScratchWorkspaceCopy(path.join(os.tmpdir(), "mana-scratch-does-not-exist"));
  });
});

// Reproduces this repo's actual layout: REPO_ROOT (acp-autonomous-loop.js's
// default) is the monorepo root one level above node-bot, so node_modules
// lives at "node-bot/node_modules", not at the source root's own top level.
// A top-level-only check would miss this entirely -- every real run_tests
// call against this repo would fail on missing dependencies.
test("createScratchWorkspaceCopy junctions a node_modules nested under a subdirectory, not just at the root", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "mana-scratch-monorepo-"));
  fs.mkdirSync(path.join(source, "node-bot", "node_modules", "axios"), { recursive: true });
  fs.writeFileSync(path.join(source, "node-bot", "package.json"), '{"name":"node-bot"}\n');
  fs.writeFileSync(path.join(source, "node-bot", "node_modules", "axios", "index.js"), "module.exports = {};\n");

  let scratchDir;
  try {
    scratchDir = createScratchWorkspaceCopy(source);

    const nestedNodeModules = path.join(scratchDir, "node-bot", "node_modules");
    assert.equal(fs.lstatSync(nestedNodeModules).isSymbolicLink(), true);
    assert.equal(
      fs.readFileSync(path.join(nestedNodeModules, "axios", "index.js"), "utf8"),
      "module.exports = {};\n",
      "the nested node_modules must resolve to real installed dependencies",
    );
    assert.equal(
      fs.readFileSync(path.join(scratchDir, "node-bot", "package.json"), "utf8"),
      '{"name":"node-bot"}\n',
    );
  } finally {
    if (scratchDir) removeScratchWorkspaceCopy(scratchDir);
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test("findNodeModulesDirs does not descend into a found node_modules or into an excluded directory", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "mana-scratch-find-nm-"));
  fs.mkdirSync(path.join(source, "app", "node_modules", "some-dep", "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(source, ".git", "node_modules"), { recursive: true }); // should never be found
  try {
    const found = findNodeModulesDirs(source, new Set([".git", "node_modules"]), fs.readdirSync);
    assert.deepEqual(found, [path.join(source, "app", "node_modules")]);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test("createScratchWorkspaceCopy works when the source has no node_modules at all", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "mana-scratch-no-deps-"));
  fs.writeFileSync(path.join(source, "app.py"), "print('hi')\n");
  let scratchDir;
  try {
    scratchDir = createScratchWorkspaceCopy(source);
    assert.equal(fs.readFileSync(path.join(scratchDir, "app.py"), "utf8"), "print('hi')\n");
    assert.equal(fs.existsSync(path.join(scratchDir, "node_modules")), false);
  } finally {
    if (scratchDir) removeScratchWorkspaceCopy(scratchDir);
    fs.rmSync(source, { recursive: true, force: true });
  }
});
