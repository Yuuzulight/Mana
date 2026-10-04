const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApprovalGate } = require('../../../node-bot/approval-gate');
const { createBrowserAutomationToolSource, APPROVAL_ACTION_TYPE } = require('../browser-automation-tool-source');

test('personal clicks always ask even after always-allow; approval executes only the proposed action once', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-personal-approval-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gate = createApprovalGate({ dataDir: dir });
  let clicked = 0;
  let url = 'https://site.test/';
  const listeners = new Set();
  const snapshot = () => ({ url, title: 'Site', added: [], removed: [], text: 'page' });
  const session = { personal: true, sessionId: 'chat', url: async () => url, click: async () => { clicked++; return snapshot(); }, snapshot: async () => snapshot(), screenshot: async () => null,
    onInvalidated: callback => { listeners.add(callback); return () => listeners.delete(callback); },
  };
  const source = createBrowserAutomationToolSource({ approvalGate: gate, getSession: async deps => { assert.equal(deps.sessionId, 'chat'); return session; } }).forSession('chat');
  await gate.requestApproval(APPROVAL_ACTION_TYPE, { summary: 'Browser use' });
  await gate.decide(gate.listPending()[0].id, 'always-allow');
  await assert.rejects(source.executeTool('browser_automation__click', { ref: 'e1', sessionId: 'attacker-chat' }), /approval/);
  const first = gate.listPending()[0];
  assert.equal(first.forceReview, true);
  assert.equal(first.payload.sessionId, 'chat');
  assert.equal(clicked, 0);
  await gate.decide(first.id, 'always-allow');
  assert.equal(clicked, 1);
  assert.equal(listeners.size, 0);
  await assert.rejects(source.executeTool('browser_automation__click', { ref: 'e1' }), /approval/);
  assert.equal(clicked, 1);
  url = 'https://site.test/another-page';
  await assert.rejects(gate.decide(gate.listPending()[0].id, 'allow-once'), /page changed/);
  assert.equal(clicked, 1);
  await assert.rejects(source.executeTool('browser_automation__click', { ref: 'e1' }), /approval/);
  for (const listener of [...listeners]) listener();
  assert.equal(listeners.size, 0);
  await assert.rejects(gate.decide(gate.listPending()[0].id, 'allow-once'), /expired/);
  assert.equal(clicked, 1);
});
