const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { scanDir } = require('../tools/dir_scanner');

function createSampleTree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-scan-'));
  fs.mkdirSync(path.join(base, 'sub'));
  fs.writeFileSync(path.join(base, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(base, 'b.js'), 'console.log(1)');
  fs.writeFileSync(path.join(base, 'sub', 'c.py'), 'print(2)');
  return base;
}

test('dir_scanner lists files and directories', () => {
  const base = createSampleTree();
  try {
    const list = scanDir(base, { path: base, maxDepth: 5, exts: null, exclude: [] });
    // Should include base files and subdir
    const paths = list.map((i)=>i.path).sort();
    assert.ok(paths.includes('a.txt'));
    assert.ok(paths.includes('b.js'));
    assert.ok(paths.includes('sub/'));
    assert.ok(paths.includes('sub/c.py'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('dir_scanner filters by extension and exclude', () => {
  const base = createSampleTree();
  try {
    const list = scanDir(base, { path: base, maxDepth: 5, exts: ['.js'], exclude: ['sub'] });
    const paths = list.map((i)=>i.path);
    assert.ok(paths.includes('b.js'));
    assert.ok(!paths.includes('a.txt'));
    assert.ok(!paths.some(p=>p.startsWith('sub/')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
