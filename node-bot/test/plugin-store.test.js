const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { PluginStore } = require("../plugin-store");

function tempPluginsDir() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mana-plugin-store-")), "plugins");
}

// Regression test for a review finding: the constructor used to
// eagerly fs.mkdirSync(pluginsDir), meaning every process that merely
// requires plugin-store.js (every test that requires server.js, since
// server.js requires this at module scope) created a real directory on
// disk as a side effect of importing it -- confirmed by finding
// node-bot/tools/plugins/ on disk after nothing more than a require().
test("constructing a PluginStore does not create pluginsDir on disk", () => {
  const pluginsDir = tempPluginsDir();
  assert.equal(fs.existsSync(pluginsDir), false);

  new PluginStore({ pluginsDir });

  assert.equal(fs.existsSync(pluginsDir), false, "the constructor must not touch the filesystem");
});

test("list() on a store whose pluginsDir doesn't exist yet returns an empty array, not a crash", () => {
  const store = new PluginStore({ pluginsDir: tempPluginsDir() });
  assert.deepEqual(store.list(), []);
});
