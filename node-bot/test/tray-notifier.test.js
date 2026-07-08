const test = require('node:test');
const assert = require('node:assert/strict');

// Ensure small debounce for tests
process.env.AUDIT_TRAY_DEBOUNCE_MS = process.env.AUDIT_TRAY_DEBOUNCE_MS || '100';
process.env.AUDIT_TRAY_AGGREGATE_LIMIT = process.env.AUDIT_TRAY_AGGREGATE_LIMIT || '100';

const tray = require('../tray-notifier');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('sendImmediateAuditTray invokes broadcaster immediately', async () => {
  const calls = [];
  tray.setBroadcaster((payload) => {
    calls.push(payload);
    return true;
  });

  const entry = { action: 'manual_apply', approver: 'tester', removed: ['a'] };
  const ok = await tray.sendImmediateAuditTray(entry);
  assert.equal(ok, true);
  // immediate should call broadcaster synchronously or very shortly
  await wait(10);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'audit');
  assert.ok(calls[0].text.includes('manual_apply'));
});

test('sendAuditTray debounces multiple entries into a single aggregated notification', async () => {
  const calls = [];
  tray.setBroadcaster((payload) => {
    calls.push(payload);
    return true;
  });

  // enqueue multiple audit entries rapidly
  for (let i = 0; i < 5; i++) {
    tray.sendAuditTray({ action: 'manual_apply', approver: `u${i}`, removed: [i] });
  }

  // wait longer than debounce window
  await wait(Number(process.env.AUDIT_TRAY_DEBOUNCE_MS || 100) + 150);

  // Should have flushed once with aggregated payload
  assert.ok(calls.length >= 1, 'expected at least one aggregated notification');
  const aggregated = calls[calls.length - 1];
  assert.equal(aggregated.type, 'audit');
  assert.ok(aggregated.text && aggregated.text.includes('audit entries'));
  assert.ok(aggregated.meta && aggregated.meta.count >= 5, 'expected aggregated count >= 5');
});
