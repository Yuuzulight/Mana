const test = require('node:test');
const assert = require('node:assert/strict');
const arb = require('../utils/turn_arbiter');

test('turn arbiter honors priority ordering', async () => {
  // Acquire initial turn and hold it to force queuing
  const release0 = await arb.acquireTurn(1);
  const order = [];

  const pHigh = arb.acquireTurn(0).then((release) => {
    order.push('high');
    try { release(); } catch (e) {}
  });
  const pMid = arb.acquireTurn(1).then((release) => {
    order.push('mid');
    try { release(); } catch (e) {}
  });
  const pLow = arb.acquireTurn(2).then((release) => {
    order.push('low');
    try { release(); } catch (e) {}
  });

  // release initial holder to allow queued tasks to run
  release0();

  await Promise.all([pHigh, pMid, pLow]);
  assert.deepEqual(order, ['high', 'mid', 'low']);
});


test('turn arbiter acquire times out when waiting too long', async () => {
  const release = await arb.acquireTurn(1);
  try {
    // attempt to acquire with very small timeout
    await assert.rejects(async () => {
      await arb.acquireTurn(5, { timeoutMs: 20 });
    }, /turn_acquire_timeout/);
  } finally {
    try { release(); } catch (e) {}
  }
});
