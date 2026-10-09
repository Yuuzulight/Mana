const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApprovalGate } = require('../approval-gate');
const { approveSelfWorkTests } = require('../tools/self-work-test-approval');

test('Stop during an approved run waits for execution cleanup before settling', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-test-cleanup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const gate = createApprovalGate({ dataDir: directory });
  let stopped = false;
  let finish;
  let settled = false;
  const waiting = approveSelfWorkTests({ gate, command: 'node --test a.test.js', cwd: '/workspace', cancelled: () => stopped,
    run: () => new Promise(resolve => { finish = resolve; }) });
  waiting.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  const approved = gate.decide(gate.listPending()[0].id, 'allow-once');
  await new Promise(resolve => setImmediate(resolve));
  stopped = true;
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(settled, false);
  finish({ exitCode: 1, cleanupComplete: true });
  await approved;
  assert.deepEqual(await waiting, { exitCode: 1, cleanupComplete: true });
});

test('self-work recommends either profile but executes only the exact human-approved run', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-test-approval-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const gate = createApprovalGate({ dataDir: directory });
  const ran = [];
  const promise = approveSelfWorkTests({ gate, command: 'node run_tests.js', cwd: '/workspace', cancelled: () => false, run: profile => { ran.push(profile); return { exitCode: 0 }; } });
  await new Promise(resolve => setImmediate(resolve));
  const pending = gate.listPending()[0];
  assert.equal(pending.forceReview, true);
  assert.equal(pending.payload.recommendation.id, 'large');
  assert.deepEqual(ran, []);
  await gate.decide(pending.id, 'always-allow');
  assert.deepEqual(await promise, { exitCode: 0 });
  assert.equal(ran.length, 1);
  const second = approveSelfWorkTests({ gate, command: 'node run_tests.js', cwd: '/workspace', estimate: { minutes: 2, reason: 'Two tiny tests' }, cancelled: () => false, run: profile => { ran.push(profile); } });
  const denied = assert.rejects(second, /denied/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gate.listPending()[0].payload.recommendation.id, 'standard');
  await gate.decide(gate.listPending()[0].id, 'deny');
  await denied;
  assert.equal(ran.length, 1);
});

test('stopped self-work cannot execute through a retained approval', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-test-stop-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const gate = createApprovalGate({ dataDir: directory });
  let stopped = false;
  const waiting = approveSelfWorkTests({ gate, command: 'node --test a.test.js', cwd: '/workspace', cancelled: () => stopped, run: () => assert.fail('must not execute') });
  const rejected = assert.rejects(waiting, /cancelled/);
  await new Promise(resolve => setImmediate(resolve));
  const id = gate.listPending()[0].id;
  stopped = true;
  await rejected;
  await assert.rejects(gate.decide(id, 'allow-once'), /expired|stopped/);
});
