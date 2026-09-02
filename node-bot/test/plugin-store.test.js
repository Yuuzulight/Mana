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

// CodeQL review: uninstall(name)/get(name) built their target path with a
// plain path.join(pluginsDir, name) -- name is a direct, unvalidated
// caller-supplied string (reachable via POST /plugins/store/toggle and any
// future route using get()/uninstall()), so a crafted name could resolve
// outside pluginsDir entirely. uninstall() is the more serious case: it's
// a recursive delete.
test("uninstall() refuses a plugin name that would resolve outside pluginsDir, instead of deleting there", () => {
  const pluginsDir = tempPluginsDir();
  fs.mkdirSync(pluginsDir, { recursive: true });
  const canaryDir = path.dirname(pluginsDir);
  const canaryFile = path.join(canaryDir, "canary.txt");
  fs.writeFileSync(canaryFile, "must survive");

  const store = new PluginStore({ pluginsDir });
  const result = store.uninstall("../" + path.basename(canaryFile));

  assert.equal(result, false, "must report not-found/refused, not succeed");
  assert.equal(fs.existsSync(canaryFile), true, "the file outside pluginsDir must be untouched");
});

test("get() refuses a plugin name that would resolve outside pluginsDir, instead of reading it", () => {
  const pluginsDir = tempPluginsDir();
  fs.mkdirSync(pluginsDir, { recursive: true });
  const canaryDir = path.dirname(pluginsDir);
  fs.mkdirSync(path.join(canaryDir, "secret"), { recursive: true });
  fs.writeFileSync(
    path.join(canaryDir, "secret", "manifest.json"),
    JSON.stringify({ name: "secret", version: "1.0.0" }),
  );

  const store = new PluginStore({ pluginsDir });
  assert.equal(store.get("../secret"), null);
});

// CodeQL review (SSRF): installFromGitHub used to validate its input URL
// with plain string-prefix checks (url.startsWith("https://github.com/")),
// which a URL like "https://raw.githubusercontent.com@evil.com/x" or
// "https://github.com.evil.com/x" satisfies as a *string* while actually
// resolving to an attacker-controlled host. Real URL parsing + an exact
// hostname allowlist should reject both before any network call happens.
test("installFromGitHub rejects a URL whose host isn't actually an allowed GitHub host, even if the string starts with one", async () => {
  const store = new PluginStore({ pluginsDir: tempPluginsDir() });

  // Same convention as the pre-existing "invalid URL" checks in this
  // function (e.g. a non-string url) -- input-validation failures reject
  // directly; only errors during the install itself (inside the function's
  // own try/catch) become a {success:false} result.
  await assert.rejects(
    () => store.installFromGitHub("https://raw.githubusercontent.com@evil.com/a/b/main"),
    /host/i,
  );
  await assert.rejects(
    () => store.installFromGitHub("https://github.com.evil.com/a/b"),
    /host/i,
  );
});

// CodeQL review (path-injection): installFromLocal/installFromDirectory/
// copyDirectory used to accept an arbitrary local path with no boundary at
// all. They're now confined to an allowlist of root directories
// (options.allowedSourceRoots, or MANA_ALLOWED_PLUGIN_SOURCE_ROOTS, or
// os.homedir() by default).
test("PluginStore defaults allowedSourceRoots to the OS home directory when nothing is configured", () => {
  const store = new PluginStore({ pluginsDir: tempPluginsDir() });
  assert.deepEqual(store.allowedSourceRoots, [os.homedir()]);
});

test("installFromDirectory succeeds for a source directory under an allowed root", async () => {
  const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mana-plugin-allowed-"));
  const sourceDir = path.join(allowedRoot, "my-plugin");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, "manifest.json"),
    JSON.stringify({ name: "my-plugin", version: "1.0.0" }),
  );

  const store = new PluginStore({ pluginsDir: tempPluginsDir(), allowedSourceRoots: [allowedRoot] });
  const result = await store.installFromDirectory(sourceDir);

  assert.equal(result.success, true);
  assert.equal(fs.existsSync(path.join(result.path, "manifest.json")), true);
});

test("installFromDirectory refuses a source directory outside every allowed root", async () => {
  const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mana-plugin-allowed-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-plugin-outside-"));
  fs.writeFileSync(
    path.join(outsideDir, "manifest.json"),
    JSON.stringify({ name: "sneaky-plugin", version: "1.0.0" }),
  );
  const pluginsDir = tempPluginsDir();

  const store = new PluginStore({ pluginsDir, allowedSourceRoots: [allowedRoot] });

  await assert.rejects(() => store.installFromDirectory(outsideDir), /allowed root/i);
  assert.equal(fs.existsSync(pluginsDir), false, "nothing should have been installed");
});

test("installFromLocal refuses a manifest.json path outside every allowed root", async () => {
  const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mana-plugin-allowed-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-plugin-outside-"));
  const outsideManifest = path.join(outsideDir, "manifest.json");
  fs.writeFileSync(outsideManifest, JSON.stringify({ name: "sneaky-plugin", version: "1.0.0" }));

  const store = new PluginStore({ pluginsDir: tempPluginsDir(), allowedSourceRoots: [allowedRoot] });

  await assert.rejects(() => store.installFromLocal(outsideManifest), /allowed root/i);
});

test("copyDirectory refuses a source directory outside every allowed root, leaving the destination untouched", () => {
  const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mana-plugin-allowed-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-plugin-outside-"));
  fs.writeFileSync(path.join(outsideDir, "secret.txt"), "must not be copied");
  const destDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mana-plugin-dest-")), "dest");

  const store = new PluginStore({ pluginsDir: tempPluginsDir(), allowedSourceRoots: [allowedRoot] });

  assert.throws(() => store.copyDirectory(outsideDir, destDir), /allowed root/i);
  assert.equal(fs.existsSync(destDir), false);
});
