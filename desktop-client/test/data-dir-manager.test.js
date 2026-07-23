const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { getManaDataRoot, buildDataDirEnv, migrateLegacyData } = require("../data-dir-manager");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-datadir-test-"));
}

test("getManaDataRoot resolves under the app's userData directory", () => {
  const fakeApp = { getPath: (name) => (name === "userData" ? "C:\\Users\\Someone\\AppData\\Roaming\\Mana" : "") };
  assert.equal(
    getManaDataRoot(fakeApp),
    path.join("C:\\Users\\Someone\\AppData\\Roaming\\Mana", "node-bot-data"),
  );
});

test("buildDataDirEnv points every known store env var at a subpath of the root", () => {
  const root = "C:\\fake\\root";
  const env = buildDataDirEnv(root);
  for (const value of Object.values(env)) {
    assert.ok(value.startsWith(root), `${value} should be under ${root}`);
  }
  assert.equal(env.MANA_ACP_MEMORY_DIR, path.join(root, "acp-memory"));
  assert.equal(env.MANA_JOB_APPLICATIONS_DIR, path.join(root, "job-applications"));
});

test("migrateLegacyData copies old data into the new root when the new root is empty", () => {
  const legacy = tempDir();
  const newRoot = path.join(tempDir(), "does-not-exist-yet");
  fs.writeFileSync(path.join(legacy, "accounts.json"), '{"ok":true}');

  const result = migrateLegacyData(legacy, newRoot, { log: () => {}, error: () => {} });

  assert.equal(result.migrated, true);
  assert.equal(fs.readFileSync(path.join(newRoot, "accounts.json"), "utf8"), '{"ok":true}');
  // legacy copy is left in place, not moved
  assert.ok(fs.existsSync(path.join(legacy, "accounts.json")));
});

test("migrateLegacyData does nothing when the new root already has data", () => {
  const legacy = tempDir();
  const newRoot = tempDir();
  fs.writeFileSync(path.join(legacy, "old.json"), "old");
  fs.writeFileSync(path.join(newRoot, "already-here.json"), "here");

  const result = migrateLegacyData(legacy, newRoot, { log: () => {}, error: () => {} });

  assert.equal(result.migrated, false);
  assert.ok(!fs.existsSync(path.join(newRoot, "old.json")));
});

test("migrateLegacyData does nothing when there's no legacy data", () => {
  const legacy = path.join(tempDir(), "never-existed");
  const newRoot = path.join(tempDir(), "fresh");

  const result = migrateLegacyData(legacy, newRoot, { log: () => {}, error: () => {} });

  assert.equal(result.migrated, false);
  assert.ok(!fs.existsSync(newRoot));
});
