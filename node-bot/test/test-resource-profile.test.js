const test = require('node:test');
const assert = require('node:assert/strict');
const { recommendTestProfile, testProfile } = require('../tools/test-resource-profile');

test('focused tests recommend 15 minutes; builds and full suites recommend 30 when unmeasured', () => {
  assert.equal(recommendTestProfile({ command: 'node --test test/a.test.js' }).id, 'standard');
  for (const command of ['node run_tests.js', 'dotnet test', 'npm run test:e2e']) assert.equal(recommendTestProfile({ command }).id, 'large');
});

test('Mana estimates and actual measurements select either fixed resource profile', () => {
  assert.equal(recommendTestProfile({ command: 'dotnet test', estimate: { minutes: 3, memoryMb: 700, processes: 4, reason: 'One test class' } }).id, 'standard');
  for (const estimate of [{ minutes: 16 }, { memoryMb: 2049 }, { processes: 33 }]) assert.equal(recommendTestProfile({ estimate }).id, 'large');
  const result = recommendTestProfile({ estimate: { minutes: 2 }, measured: { minutes: 17 } });
  assert.equal(result.id, 'large');
  assert.equal(result.timeoutMs, 1800000);
  assert.equal(result.estimate.minutes, 17);
  assert.equal(recommendTestProfile({ estimate: { minutes: 31 } }).exceedsAvailableProfiles, true);
});

test('invalid estimates and arbitrary profile names cannot define new execution limits', () => {
  for (const minutes of [-1, Infinity, NaN, '30']) assert.throws(() => recommendTestProfile({ estimate: { minutes } }), /Invalid/);
  for (const name of ['unlimited', '__proto__', 'constructor', 'toString']) assert.throws(() => testProfile(name), /Unknown/);
  assert.ok(Object.isFrozen(testProfile('large')));
});
