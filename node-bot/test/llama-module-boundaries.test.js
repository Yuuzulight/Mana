const test = require('node:test');
const assert = require('node:assert/strict');
const { createLifecycle } = require('../ai/llama/lifecycle');

test('llama module factories do not start processes, timers, or read late-bound state', () => {
  for (const file of [
    'model-discovery', 'server-config', 'server-startup', 'lifecycle',
    'completions', 'tool-calls', 'goal-review', 'tool-reply',
  ]) {
    const exports = require(`../ai/llama/${file}`);
    const factory = Object.values(exports)[0];
    const context = new Proxy({}, { get() { throw new Error('eager dependency access'); } });
    assert.ok(factory(context));
  }
});

test('stop clears owned runtime state and records the real child-exit promise', async () => {
  const child = { pid: 123 };
  const idleTimer = setTimeout(() => assert.fail('idle timer survived stop'), 1000);
  const state = { child, model: 'model', mmproj: 'vision', port: 8099, idleTimer };
  let killed;
  let exited;
  const stopping = new Promise(resolve => { exited = resolve; });
  const lifecycle = createLifecycle({
    state, platform: 'win32', env: {},
    killProcessTree: value => { killed = value; },
    waitForExit: value => { assert.equal(value, child); return stopping; },
  });
  assert.equal(lifecycle.stop(), child);
  assert.equal(killed, child);
  assert.equal(state.stopping, stopping);
  assert.equal(state.child, null);
  assert.equal(state.model, null);
  assert.equal(state.mmproj, null);
  assert.equal(state.port, null);
  assert.equal(state.idleTimer, null);
  exited(true);
  assert.equal(await state.stopping, true);
  assert.equal(lifecycle.stop(), null);
});

test('stop does not kill an adopted server owned by another process', () => {
  const state = { child: null, model: 'external', port: 8099 };
  const lifecycle = createLifecycle({ state, killProcessTree: () => assert.fail('killed external process') });
  assert.equal(lifecycle.stop(), null);
  assert.equal(state.port, null);
});

test('a failed turn releases its in-flight count and deferred context override', async () => {
  const state = { busy: 0, gamingSwapPending: null, visionUnloadPending: false, contextRestorePending: true, contextOverride: 16384 };
  const lifecycle = createLifecycle({ state });
  const run = lifecycle.inTurn(async () => {
    assert.equal(state.busy, 1);
    throw new Error('completion failed');
  });
  await assert.rejects(run(), /completion failed/);
  assert.equal(state.busy, 0);
  assert.equal(state.contextOverride, null);
  assert.equal(state.contextRestorePending, false);
});
