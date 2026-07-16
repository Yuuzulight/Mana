const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createApp } = require('../server');
const { withServer } = require('./helpers');

// helper to write audit sample
function writeAuditLines(lines) {
  const p = path.join(__dirname, '..', 'data', 'vector_rebuild_audit.jsonl');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

test('vector rebuild audit endpoints', async () => {
  const sample = [
    { at: '2026-01-01T00:00:00Z', approver: 'admin', action: 'vector_rebuild', status: 'started', dir: '/tmp' },
    { at: '2026-01-01T00:01:00Z', approver: 'admin', action: 'vector_rebuild', status: 'done', dir: '/tmp', added: 2, count: 2 }
  ];
  writeAuditLines(sample);

  const app = createApp();
  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/admin/retriever/vector/rebuild/audit`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.ok, true);
    assert.equal(body.total, 2);
    assert.ok(Array.isArray(body.entries));

    // CSV export
    const csvResp = await fetch(`${baseUrl}/admin/retriever/vector/rebuild/audit.csv`);
    assert.equal(csvResp.status, 200);
    const csvText = await csvResp.text();
    assert.ok(csvText.includes('vector_rebuild'));
  });
});
