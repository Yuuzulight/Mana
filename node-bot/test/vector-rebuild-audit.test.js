// Points the server at a temp audit file instead of the real
// node-bot/data/vector_rebuild_audit.jsonl before requiring server.js --
// VECTOR_REBUILD_AUDIT_PATH is a module-level const resolved at require
// time, so this must happen first. Without it, this test overwrote
// Aurora's real audit log with its 2-line fixture on every run.
const os = require('node:os');
const path = require('path');
const fs = require('fs');

const tempAuditPath = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'mana-vector-audit-test-')),
  'vector_rebuild_audit.jsonl',
);
process.env.MANA_VECTOR_AUDIT_PATH = tempAuditPath;

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../server');
const { withServer } = require('./helpers');

test.after(() => {
  fs.rmSync(path.dirname(tempAuditPath), { recursive: true, force: true });
  delete process.env.MANA_VECTOR_AUDIT_PATH;
});

// helper to write audit sample
function writeAuditLines(lines) {
  fs.mkdirSync(path.dirname(tempAuditPath), { recursive: true });
  fs.writeFileSync(tempAuditPath, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
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
