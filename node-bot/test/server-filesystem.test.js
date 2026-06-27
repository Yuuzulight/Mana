const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ensureDirectory } = require("../server");

test("ensureDirectory can be called repeatedly for the same directory", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "mana-dir-test-"));
  const target = path.join(parent, "tmp");

  try {
    assert.doesNotThrow(() => ensureDirectory(target));
    assert.equal(fs.statSync(target).isDirectory(), true);
    assert.doesNotThrow(() => ensureDirectory(target));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
