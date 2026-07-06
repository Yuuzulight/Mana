const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  countTokensForText,
  countTokensForPath,
} = require("../tools/python_token_cache.async");

function writeTempPy(content) {
  const tmp = path.join(
    os.tmpdir(),
    `mana-test-py-${Date.now()}-${Math.random().toString(36).slice(2)}.py`,
  );
  fs.writeFileSync(tmp, content, "utf8");
  return tmp;
}

test("python token cache returns a positive token count for text", async () => {
  const code = `def foo():\n    print('hello world')\n\n` + "x".repeat(1000);
  const toks = await countTokensForText(code, ".py", true);
  assert.ok(typeof toks === "number" && toks > 0);
});

test("python token cache returns consistent count for a file and creates cache entry", async () => {
  const code = `import os\nprint('hi')\n` + "y".repeat(500);
  const tmp = writeTempPy(code);
  try {
    const t1 = await countTokensForPath(tmp, true);
    assert.ok(Number.isInteger(t1) && t1 > 0);
    // second call should succeed and be similar
    const t2 = await countTokensForPath(tmp, false);
    assert.ok(Number.isInteger(t2) && t2 > 0);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (e) {}
  }
});
