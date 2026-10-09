const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createResourceCoordinator } = require('../utils/resource-coordinator');
const { createHardwareTelemetry } = require('../utils/resource-service');

function fixture(t, overrides = {}) {
  let clock = 1000;
  let sample = { at: clock, ramTotalMb: 10000, ramFreeMb: 10000, vramFreeMb: 8000, cpuTotal: 16 };
  const coordinator = createResourceCoordinator({ telemetry: async () => ({ ...sample }), now: () => clock, pollMs: 5, ...overrides });
  t.after(() => coordinator.close());
  return { coordinator, set: value => { sample = { ...sample, ...value }; }, advance: ms => { clock += ms; sample.at = clock; } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('overlapping requests reserve headroom atomically and release idempotently', async t => {
  const { coordinator } = fixture(t);
  const first = await coordinator.acquire({ owner: 'one', estimate: { vramMb: 5000 } });
  const pending = coordinator.acquire({ owner: 'two', estimate: { vramMb: 5000 } });
  await flush();
  assert.equal(coordinator.status().active.length, 1);
  assert.match(coordinator.status().queued[0].reason, /existing reservations/);
  first.release(); first.release();
  const second = await pending;
  assert.equal(coordinator.status().active.length, 1);
  second.release();
});
test('queued abort and coordinator shutdown leave no leaked reservations', async t => {
  const { coordinator } = fixture(t);
  const signal = new AbortController();
  const request = coordinator.acquire({ owner: 'blocked', estimate: { vramMb: 9000 }, signal: signal.signal });
  const rejected = assert.rejects(request, /cancelled/);
  signal.abort(new Error('cancelled'));
  await rejected;
  assert.equal(coordinator.status().queued.length, 0);
  const next = coordinator.acquire({ owner: 'next', estimate: { vramMb: 9000 } });
  const stopped = assert.rejects(next, /stopped/);
  coordinator.close();
  await stopped;
  assert.equal(coordinator.status().active.length, 0);
});
test('stale GPU telemetry queues GPU work and explicit CPU choice preserves RAM policy', async t => {
  const { coordinator, set } = fixture(t);
  set({ vramFreeMb: null });
  const pending = coordinator.acquire({ owner: 'chat-model', estimate: { vramMb: 3000, ramMb: 1000 }, cpuAlternative: { ramMb: 4000, cpu: 4 } });
  await flush();
  const queued = coordinator.status().queued[0];
  assert.match(queued.reason, /GPU-memory/);
  coordinator.chooseCpu(queued.id);
  const lease = await pending;
  assert.equal(lease.mode, 'cpu');
  assert.equal(coordinator.status().active[0].estimate.vramMb, 0);
  lease.release();
  set({ at: -10000 });
  const stale = coordinator.acquire({ owner: 'stale', estimate: { ramMb: 1 }, timeoutMs: 10 });
  await assert.rejects(stale, /fresh hardware/);
});
test('process termination, not a Stop request, releases residency', async t => {
  const { coordinator } = fixture(t);
  const lease = await coordinator.acquire({ owner: 'model', kind: 'residency', estimate: { vramMb: 5000 } });
  const child = new EventEmitter(); child.pid = 123;
  lease.attachProcess(child);
  assert.equal(lease.release(), false);
  assert.equal(coordinator.status().active[0].state, 'stopping');
  child.emit('exit', 1);
  child.emit('close', 1);
  assert.equal(coordinator.status().active.length, 0);
});
test('trusted observed residency avoids double counting without trusting missing readings', async t => {
  const { coordinator, set } = fixture(t);
  const first = await coordinator.acquire({ owner: 'resident', kind: 'residency', estimate: { vramMb: 5000 } });
  set({ vramFreeMb: 3000, observed: { [first.id]: { vramMb: 5000 } } });
  const second = await coordinator.acquire({ owner: 'job', estimate: { vramMb: 2000 } });
  second.release(); first.release();
});
test('interactive work pauses new background steps, not running tests', async t => {
  const { coordinator } = fixture(t);
  const tests = await coordinator.acquire({ owner: 'tests', background: true, estimate: { cpu: 8, ramMb: 2048 } });
  const voice = await coordinator.acquire({ owner: 'voice', priority: 0, estimate: { cpu: 2 } });
  const background = coordinator.acquire({ owner: 'self-work-boundary', background: true, estimate: {} });
  await flush();
  assert.equal(coordinator.status().active.length, 2);
  assert.match(coordinator.status().queued[0].reason, /safe boundary/);
  voice.release();
  const resumed = await background;
  resumed.release(); tests.release();
});
test('background CPU headroom and RAM headroom are enforced', async t => {
  const { coordinator } = fixture(t);
  await assert.rejects(coordinator.acquire({ owner: 'too-large', background: true, estimate: { cpu: 15 }, timeoutMs: 10 }), /cpu/);
  await assert.rejects(coordinator.acquire({ owner: 'RAM', background: true, estimate: { ramMb: 8501 }, timeoutMs: 10 }), /ramMb/);
});
test('aged waiting work receives FIFO precedence when capacity becomes available', async t => {
  const { coordinator, set, advance } = fixture(t);
  set({ vramFreeMb: 0 });
  const older = coordinator.acquire({ owner: 'older', background: true, estimate: { vramMb: 8000 } });
  await flush(); advance(120000);
  // Both are background jobs; active interactive work must never be evicted.
  const newer = coordinator.acquire({ owner: 'newer', background: true, priority: 1, estimate: { vramMb: 8000 } });
  set({ vramFreeMb: 8000 });
  await coordinator.refresh();
  const first = await older;
  assert.equal(coordinator.status().active[0].owner, 'older');
  first.release(); (await newer).release();
});
test('telemetry failure leaves GPU queued while a later CPU-only request can run', async t => {
  const { coordinator, set } = fixture(t);
  set({ vramFreeMb: undefined });
  const gpu = coordinator.acquire({ owner: 'gpu', estimate: { vramMb: 1 }, timeoutMs: 30 });
  const rejected = assert.rejects(gpu, /GPU-memory/);
  const cpu = await coordinator.acquire({ owner: 'cpu', estimate: { cpu: 1 } });
  cpu.release(); await rejected;
});
test('hardware adapter never credits N/A GPU usage or a different GPU', async () => {
  const adapter = createHardwareTelemetry({ platform: 'win32', now: () => 10,
    memory: { totalmem: () => 104857600, freemem: () => 52428800, availableParallelism: () => 16 },
    run: async (bin, args) => ({ stdout: bin !== 'nvidia-smi' ? '[{"Id":123,"WorkingSet64":1048576}]' : args[0].includes('query-gpu=') ? 'GPU-one, 8000\nGPU-two, 1000' : 'GPU-one, 123, N/A\nGPU-two, 123, 900' }) });
  const sample = await adapter([{ id: 'lease', pid: 123 }]);
  assert.equal(sample.vramFreeMb, 8000);
  assert.deepEqual(sample.observed.lease, { ramMb: 1 });
});

test('GPU alternatives are offered after brief telemetry retries, never selected automatically', async t => {
  const { coordinator, set } = fixture(t, { pollMs: 1000 });
  set({ vramFreeMb: undefined });
  const events = [];
  const controller = new AbortController();
  const pending = coordinator.acquire({ owner: 'GPU', estimate: { vramMb: 1 }, cpuAlternative: { ramMb: 1 }, signal: controller.signal, onWait: e => events.push(e) });
  const rejected = assert.rejects(pending);
  await flush();
  assert.equal(events[0].cpuAlternative, null);
  await coordinator.refresh(); await coordinator.refresh();
  assert.deepEqual(events.at(-1).cpuAlternative, { ramMb: 1, cpu: 0, vramMb: 0 });
  assert.equal(coordinator.status().active.length, 0);
  controller.abort(); await rejected;
});

test('failed cleanup is quarantined rather than releasing unconfirmed capacity', async t => {
  const { coordinator } = fixture(t);
  const lease = await coordinator.acquire({ owner: 'test', estimate: { ramMb: 2048 } });
  const child = new EventEmitter(); child.pid = 456; child.resourceCleanupFailed = true;
  lease.attachProcess(child); lease.release();
  child.emit('exit', 1); child.emit('close', 1);
  assert.equal(coordinator.status().active.length, 1);
  assert.match(coordinator.status().active[0].reason, /Cleanup failed/);
});

test('aged large requests prevent an endless stream of small backfilled jobs', async t => {
  const { coordinator, advance } = fixture(t);
  const holder = await coordinator.acquire({ owner: 'holder', estimate: { cpu: 8 } });
  const large = coordinator.acquire({ owner: 'large', estimate: { cpu: 12 } });
  await flush(); advance(60000);
  const small = coordinator.acquire({ owner: 'small', estimate: { cpu: 4 } });
  await coordinator.refresh();
  assert.equal(coordinator.status().active.length, 1);
  assert.match(coordinator.status().queued.find(e => e.owner === 'small').reason, /starvation/);
  holder.release();
  (await large).release(); (await small).release();
});

test('model operations are exclusive and a granted background load can reach its next safe boundary', async t => {
  const { coordinator } = fixture(t);
  const operation = await coordinator.acquire({ owner: 'background inference', background: true, exclusive: 'chat-model', estimate: { cpu: 4 } });
  const chat = coordinator.acquire({ owner: 'chat', exclusive: 'chat-model', estimate: { cpu: 4 } });
  const residency = await coordinator.scope({ background: true, admitted: true }, () => coordinator.acquire({ owner: 'load already admitted', background: true, kind: 'residency', estimate: { vramMb: 1000 } }));
  assert.equal(coordinator.status().queued.length, 1);
  operation.release(); (await chat).release(); residency.release();
});

test('device transition updates residency only within already admitted capacity', async t => {
  const { coordinator } = fixture(t);
  const model = await coordinator.acquire({ owner: 'voice', kind: 'residency', estimate: { ramMb: 1000, vramMb: 3000 } });
  const transfer = await coordinator.acquire({ owner: 'transfer', estimate: { ramMb: 3000 } });
  assert.throws(() => coordinator.reallocate(model.id, transfer.id, { ramMb: 5000 }), /exceeds/);
  coordinator.reallocate(model.id, transfer.id, { ramMb: 3000 });
  transfer.release();
  assert.equal(coordinator.status().active[0].mode, 'cpu');
  assert.equal(coordinator.status().active[0].estimate.vramMb, 0);
  model.release();
});

test('one process observation cannot be credited to two reservations', async t => {
  const { coordinator, set } = fixture(t);
  const first = await coordinator.acquire({ owner: 'first', estimate: { ramMb: 3000 } });
  const second = await coordinator.acquire({ owner: 'second', estimate: { ramMb: 3000 } });
  const child = new EventEmitter(); child.pid = 123;
  first.attachProcess(child); second.attachProcess(child);
  set({ ramFreeMb: 3000, observed: { [first.id]: { ramMb: 3000 }, [second.id]: { ramMb: 3000 } } });
  const controller = new AbortController();
  const pending = coordinator.acquire({ owner: 'new work', estimate: { ramMb: 1 }, signal: controller.signal });
  const rejected = assert.rejects(pending);
  await coordinator.refresh();
  assert.equal(coordinator.status().queued.length, 1);
  controller.abort(); await rejected;
  first.release(); second.release(); child.emit('exit', 0);
  assert.equal(coordinator.status().active.length, 0);
});

test('an asynchronously assigned helper PID remains visible for telemetry', async t => {
  const { coordinator } = fixture(t);
  const lease = await coordinator.acquire({ owner: 'helper', estimate: { ramMb: 512 } });
  const child = new EventEmitter();
  lease.attachProcess(child);
  assert.equal(coordinator.status().active[0].pid, null);
  child.pid = 678;
  assert.equal(coordinator.status().active[0].pid, 678);
  lease.release(); child.emit('close', 0);
  assert.equal(coordinator.status().active.length, 0);
});
