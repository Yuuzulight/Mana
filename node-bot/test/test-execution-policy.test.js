const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestExecutionPolicy } = require('../tools/test-execution-policy');

test('unrestricted retries require the exact previously failed sandbox command and workspace', () => {
  const policy = createTestExecutionPolicy();
  assert.equal(policy.unrestricted('node test.js', '/ws', '/ws'), false);
  assert.throws(() => policy.unrestricted('node test.js', '/ws', '/ws', 'unrestricted'), /previous sandbox failure/);
  policy.record('node test.js', '/ws', '/ws', { exitCode: 1 });
  assert.equal(policy.unrestricted('node test.js', '/ws', '/ws', 'unrestricted'), true);
  assert.throws(() => policy.unrestricted('node other.js', '/ws', '/ws', 'unrestricted'), /previous sandbox failure/);
  assert.throws(() => policy.unrestricted('node test.js', '/other', '/other', 'unrestricted'), /previous sandbox failure/);
  policy.record('node test.js', '/ws', '/ws', { exitCode: 0, timedOut: false });
  assert.throws(() => policy.unrestricted('node test.js', '/ws', '/ws', 'unrestricted'), /previous sandbox failure/);
  assert.throws(() => policy.unrestricted('node test.js', '/ws', '/ws', 'automatic'), /Unknown/);
});
