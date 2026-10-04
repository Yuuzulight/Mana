const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApprovalGate } = require('../approval-gate');
const { createDocumentAccess } = require('../document-access');

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-document-access-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'notes.txt');
  fs.writeFileSync(file, 'approved notes');
  const gate = createApprovalGate({ dataDir: path.join(dir, 'approvals') });
  return { file, gate, access: createDocumentAccess({ approvalGate: gate, ...overrides }) };
}

test('no filesystem operation occurs before explicit human approval, including with always-allow set', async t => {
  const blockedFs = new Proxy({}, { get() { assert.fail('read before approval'); } });
  const { gate, access, file } = setup(t, { fileSystem: blockedFs });
  gate.registerExecutor('document-read', () => ({ ok: true }));
  const remembered = await gate.requestApproval('document-read', {});
  await gate.decide(remembered.requestId, 'always-allow');
  assert.equal(gate.isAlwaysAllowed('document-read'), true);
  gate.registerExecutor('document-read', () => assert.fail('auto approved'));
  const first = await access.authorize(file);
  assert.equal(first.status, 'pending');
  assert.equal(gate.listPending()[0].forceReview, true);
  assert.equal((await access.authorize(file)).requestId, first.requestId);
  await gate.decide(first.requestId, 'deny');
  assert.equal((await access.authorize(file)).status, 'pending');
});

test('approved reads are one-use and scoped to the exact session and purpose', async t => {
  const { gate, access, file } = setup(t);
  const pending = await access.authorize(file, { sessionId: 'chat-a' });
  await gate.decide(pending.requestId, 'allow-once');
  assert.equal((await access.authorize(file, { sessionId: 'chat-b' })).status, 'pending');
  assert.equal((await access.authorize(file, { sessionId: 'chat-a', purpose: 'ingest' })).status, 'pending');
  const approved = await access.authorize(file, { sessionId: 'chat-a' });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.buffer.toString(), 'approved notes');
  assert.equal(approved.filename, 'notes.txt');
  assert.equal((await access.authorize(file, { sessionId: 'chat-a' })).status, 'pending');
});

test('changed files require fresh approval and the opened handle is closed on failure', async t => {
  let closed = 0;
  const fileSystem = { ...fsp, async open(...args) {
    const handle = await fsp.open(...args);
    const close = handle.close.bind(handle);
    handle.close = async () => { closed += 1; return close(); };
    return handle;
  } };
  const { gate, access, file } = setup(t, { fileSystem });
  const pending = await access.authorize(file);
  await gate.decide(pending.requestId, 'allow-once');
  fs.writeFileSync(file, 'different content');
  await assert.rejects(access.authorize(file), /Document changed/);
  assert.equal(closed, 1);
  assert.equal((await access.authorize(file)).status, 'pending');
});

test('expired grants contain no buffers and cannot read content', async t => {
  let time = 0;
  const { gate, access, file } = setup(t, { now: () => time });
  const pending = await access.authorize(file);
  await gate.decide(pending.requestId, 'allow-once');
  time += 5 * 60 * 1000;
  assert.equal((await access.authorize(file)).status, 'pending');
});

test('approval queue is bounded and invalid scopes are rejected', async t => {
  const { access, file } = setup(t);
  await assert.rejects(access.authorize(file, { sessionId: {} }), /Invalid/);
  await assert.rejects(access.authorize('bad\0path'), /valid document/);
  for (let i = 0; i < 16; i += 1) assert.equal((await access.authorize(file, { sessionId: `session-${i}` })).status, 'pending');
  await assert.rejects(access.authorize(file, { sessionId: 'overflow' }), /Too many/);
});

test('authenticated document API requires approval before returning content', async t => {
  const { file, gate } = setup(t);
  const { withServer, useTestAdminToken } = require('./helpers');
  const fetch = useTestAdminToken();
  const app = require('../server').createApp({ approvalGate: gate });
  await withServer(app, async baseUrl => {
    const request = () => fetch(`${baseUrl}/documents/extract`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: file, sessionId: 'api-chat' }),
    });
    const initial = await request();
    assert.equal(initial.status, 202);
    const pending = await initial.json();
    assert.equal(pending.status, 'pending');
    await gate.decide(pending.requestId, 'allow-once');
    const approved = await request();
    assert.equal(approved.status, 200);
    const result = await approved.json();
    assert.equal(result.text, 'approved notes');
    assert.equal(result.fileName, 'notes.txt');
    assert.equal((await request()).status, 202);
  });
});
