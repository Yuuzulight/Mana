const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { scanDir } = require("../tools/dir_scanner");

function createSampleTree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mana-scan-"));
  fs.mkdirSync(path.join(base, "sub"));
  fs.writeFileSync(path.join(base, "a.txt"), "hello");
  fs.writeFileSync(path.join(base, "b.js"), "console.log(1)");
  fs.writeFileSync(path.join(base, "sub", "c.py"), "print(2)");
  return base;
}

test("dir_scanner lists files and directories with pagination", () => {
  const base = createSampleTree();
  try {
    // create additional files to test pagination
    for (let i = 0; i < 8; i++)
      fs.writeFileSync(path.join(base, `extra${i}.txt`), "x");
    const list = scanDir(base, {
      path: base,
      maxDepth: 5,
      exts: null,
      exclude: [],
      limit: 5,
      offset: 2,
    });
    // Should return 5 items starting from offset 2
    assert.equal(list.length, 5);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("dir_scanner filters by extension and exclude", () => {
  const base = createSampleTree();
  try {
    const list = scanDir(base, {
      path: base,
      maxDepth: 5,
      exts: [".js"],
      exclude: ["sub"],
    });
    const paths = list.map((i) => i.path);
    assert.ok(paths.includes("b.js"));
    assert.ok(!paths.includes("a.txt"));
    assert.ok(!paths.some((p) => p.startsWith("sub/")));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
