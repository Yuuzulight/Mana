const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFileToolSource, generatorCode, validateSpec } = require('../ai/file-creation-tool-source');

test('file creation validates safe matching extensions and bounded content', () => {
  assert.equal(validateSpec({ format: 'csv', name: 'report.csv', tables: [{ columns: ['A'], rows: [['x']] }] }).tables.length, 1);
  assert.throws(() => validateSpec({ format: 'csv', name: '../report.csv' }), /safe filename/);
  assert.throws(() => validateSpec({ format: 'pdf', name: 'report.csv' }), /extension/);
  assert.throws(() => validateSpec({ format: 'docx', name: 'report.docx', sections: [{ body: 'x'.repeat(120001) }] }), /at most/);
});

test('generator templates cover every supported offline format', () => {
  for (const format of ['docx', 'xlsx', 'pptx', 'pdf', 'csv']) {
    const code = generatorCode({ title: 'Test', sections: [], tables: [], slides: [] }, format, `test.${format}`);
    assert.ok(code.includes(`write_${format}`));
    assert.ok(code.includes('output_dir'));
  }
});

test('file tool returns a bounded generated file through the retained output channel', async () => {
  const seen = [];
  const outputsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-file-output-'));
  const tool = createFileToolSource({
    enabled: true,
    runSandbox: async ({ code }) => {
      assert.ok(code.includes('write_csv'));
      return { files: [{ name: 'report.csv', data: Buffer.from('A\r\nvalue\r\n').toString('base64') }], error: null };
    },
    onFile: file => seen.push(file),
    outputsDir,
  });
  const result = await tool.executeTool('files__create', { format: 'csv', name: 'report.csv', tables: [{ columns: ['A'], rows: [['value']] }] });
  assert.equal(seen.length, 1);
  assert.match(result, /report\.csv/);
  assert.equal(fs.readFileSync(path.join(outputsDir, 'report.csv'), 'utf8'), 'A\r\nvalue\r\n');
  fs.rmSync(outputsDir, { recursive: true, force: true });
});

test('file tool rejects a missing or mismatched sandbox output', async () => {
  const tool = createFileToolSource({ enabled: true, runSandbox: async () => ({ files: [], error: null }) });
  await assert.rejects(() => tool.executeTool('files__create', { format: 'pdf', name: 'report.pdf' }), /without returning/);
});

