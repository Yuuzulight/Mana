const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { normalizeAnalysisOutputs, MAX_RESULT_BYTES } = require('../tools/analysis-results');
const { createAcpMemoryStore } = require('../acp-memory-store');

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const outputs = { charts: [{ dataUrl: `data:image/png;base64,${png}` }],
  files: [{ name: 'results.csv', data: Buffer.from('value\n42\n').toString('base64') }],
  tables: [{ columns: ['value'], rows: [['42']] }] };

test('outputs are bounded, canonical data rather than paths or external image links', () => {
  assert.deepEqual(normalizeAnalysisOutputs(null), { charts: [], files: [], tables: [] });
  const result = normalizeAnalysisOutputs(outputs);
  assert.equal(result.charts.length, 1);
  assert.deepEqual(result.files, outputs.files);
  assert.deepEqual(result.tables, outputs.tables);
  assert.deepEqual(normalizeAnalysisOutputs({ charts: [{ dataUrl: 'https://example.com/chart.png' }],
    files: ['../secret', 'NUL.txt', 'trailing.', 'trailing ', 'CON'].map(name => ({ name, data: 'YQ==' })) }), { charts: [], files: [], tables: [] });
  assert.equal(normalizeAnalysisOutputs({ files: [{ name: 'a', data: 'YR==' }] }).files.length, 0);
  const many = normalizeAnalysisOutputs({ files: Array.from({ length: 8 }, (_, i) => ({ name: `output${i}.csv`, data: Buffer.alloc(256000).toString('base64') })) });
  assert.ok(many.files.reduce((sum, file) => sum + Buffer.from(file.data, 'base64').length, 0) <= MAX_RESULT_BYTES);
});

test('table previews are bounded and retain cell text as data', () => {
  const result = normalizeAnalysisOutputs({ tables: [{ columns: ['name'], rows: [['[link](file:///secret)\nnext'], ['x'.repeat(1000)]] }] });
  assert.equal(result.tables[0].rows[0][0], '[link](file:///secret) next');
  assert.equal(result.tables[0].rows[1][0].length, 256);
  assert.deepEqual(normalizeAnalysisOutputs({ tables: [{ columns: [], rows: [] }, { columns: Array(9).fill('x'), rows: [] }] }).tables, []);
});

test('outputs survive restart, stay out of recall, follow reply versions and are deleted with chat', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-output-retention-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const first = createAcpMemoryStore({ dataDir });
  await first.appendTurn({ sessionId: 'analysis-chat', user: 'Calculate', assistant: 'Done', analysisOutputs: outputs });
  const second = createAcpMemoryStore({ dataDir });
  assert.deepEqual(second.getSession('analysis-chat').turns[0].analysisOutputs, normalizeAnalysisOutputs(outputs));
  assert.ok(!second.buildPromptMemory('analysis-chat').includes(png));
  second.addTurnVersion('analysis-chat', 0, { assistant: 'Revised' });
  assert.deepEqual(second.getSession('analysis-chat').turns[0].analysisOutputs, { charts: [], files: [], tables: [] });
  second.setTurnVersion('analysis-chat', 0, 0);
  assert.deepEqual(second.getSession('analysis-chat').turns[0].analysisOutputs, normalizeAnalysisOutputs(outputs));
  assert.equal(second.deleteSession('analysis-chat'), true);
  const third = createAcpMemoryStore({ dataDir });
  assert.equal(third.getSession('analysis-chat'), null);
  assert.ok(!fs.readdirSync(third.sessionsDir).length);
});

test('forked chats retain their own outputs when the original chat is deleted', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-output-fork-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = createAcpMemoryStore({ dataDir });
  await store.appendTurn({ sessionId: 'original', user: 'Calculate', assistant: 'Done', analysisOutputs: outputs });
  const fork = store.forkSession('original', { sessionId: 'fork' });
  assert.ok(fork);
  store.deleteSession('original');
  assert.deepEqual(store.getSession(fork.sessionId).turns[0].analysisOutputs, normalizeAnalysisOutputs(outputs));
  store.deleteSession(fork.sessionId);
  assert.ok(!fs.readdirSync(store.sessionsDir).length);
});
