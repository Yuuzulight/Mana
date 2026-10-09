const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createResourceCoordinator } = require('../utils/resource-coordinator');
const { createOnDemandProcess } = require('../utils/on-demand-process');
const { createLlamaServerRuntime } = require('../ai/llama-server-runtime');
const { registerNativeResourceRoutes } = require('../utils/native-resource-bridge');
const { runAnalysisSandbox } = require('../tools/analysis-sandbox');
const tick = () => new Promise(resolve => setImmediate(resolve));

function coordinator(t) {
  const service = createResourceCoordinator({ telemetry: async () => ({ at: Date.now(), ramTotalMb: 32000,
    ramFreeMb: 30000, vramFreeMb: 16000, cpuTotal: 16 }), pollMs: 5 });
  t.after(() => service.close());
  return service;
}
function child(pid) {
  const process = new EventEmitter(); process.pid = pid; process.exitCode = null;
  process.stderr = new EventEmitter();
  process.kill = () => { process.exitCode = 0; process.emit('exit', 0); process.emit('close', 0); return true; };
  return process;
}

test('on-demand residency protects active users from idle eviction and frees after crash', async t => {
  const resources = coordinator(t);
  let process, complete;
  const runtime = createOnDemandProcess({ name: 'owned model', command: () => ({ bin: 'fake', args: [] }),
    healthUrl: () => 'fake', idleMs: () => 0, platform: 'linux',
    resourceCoordinator: resources, resourceEstimate: () => ({ vramMb: 14000 }),
    fetch: async () => ({ ok: !!process && process.exitCode === null }), spawn: () => (process = child(123)) });
  const busy = runtime.use(() => new Promise(resolve => { complete = resolve; }));
  while (!complete) await tick();
  const controller = new AbortController();
  const queued = resources.acquire({ owner: 'chat', estimate: { vramMb: 4000 }, signal: controller.signal });
  const rejected = assert.rejects(queued);
  await tick();
  assert.equal(process.exitCode, null, 'an active model was not evicted');
  controller.abort(); await rejected;
  complete(); await busy;
  process.kill();
  assert.equal(resources.status().active.length, 0);
});

test('a queued on-demand model start is cancelled by Stop without spawning', async t => {
  const resources = coordinator(t);
  const holder = await resources.acquire({ owner: 'holder', estimate: { vramMb: 16000 } });
  let spawned = false;
  const runtime = createOnDemandProcess({ name: 'queued model', command: () => ({ bin: 'fake', args: [] }),
    healthUrl: () => 'fake', idleMs: () => 0, resourceCoordinator: resources, resourceEstimate: () => ({ vramMb: 1000 }),
    fetch: async () => ({ ok: false }), spawn: () => { spawned = true; return child(123); } });
  const waiting = runtime.ensure();
  const rejected = assert.rejects(waiting, /stopped/);
  while (!resources.status().queued.length) await tick();
  runtime.stop(); await rejected;
  assert.equal(spawned, false);
  assert.equal(resources.status().queued.length, 0);
  holder.release();
});

test('model runtime keeps residency but releases turn allocations after each reply', async t => {
  const resources = coordinator(t);
  let process;
  const runtime = createLlamaServerRuntime({ resourceCoordinator: resources, platform: 'linux', threads: 4,
    env: { LLAMA_SERVER_BIN: 'C:\\llama\\llama-server.exe', LLAMA_MODEL: 'C:\\models\\mana.gguf', LLAMA_SERVER_IDLE_MS: '0', LLAMA_SERVER_PORT: '8099' },
    fs: { existsSync: file => /llama-server.exe|mana.gguf/.test(file), statSync: () => ({ size: 1024 * 1048576, isFile: () => true }) },
    probeHelp: () => '--device --load-mode --cache-ram', registerExitHandlers: false,
    spawn: () => (process = child(234)), sleep: tick,
    fetch: async url => String(url).endsWith('/health') ? { ok: !!process && process.exitCode === null }
      : { ok: true, json: async () => ({ choices: [{ message: { content: 'hello' } }] }) } });
  assert.equal(await runtime.runLocalAssistantReply('hello', 8), 'hello');
  assert.equal(resources.status().active.length, 1);
  assert.equal(resources.status().active[0].kind, 'residency');
  assert.equal(await runtime.runLocalAssistantReply('again', 8), 'hello');
  runtime.stop();
  assert.equal(resources.status().active.length, 0);
});

test('proxied response retains the model lock through body consumption and cancellation', async t => {
  const resources = coordinator(t);
  let process, end;
  const runtime = createLlamaServerRuntime({ resourceCoordinator: resources, platform: 'linux', threads: 4,
    env: { LLAMA_SERVER_BIN: 'C:\\llama\\llama-server.exe', LLAMA_MODEL: 'C:\\models\\mana.gguf', LLAMA_SERVER_IDLE_MS: '1' },
    fs: { existsSync: () => true, statSync: () => ({ size: 1024 * 1048576, isFile: () => true }) },
    probeHelp: () => '--device --cache-ram', registerExitHandlers: false,
    spawn: () => (process = child(345)), sleep: tick,
    fetch: async url => String(url).endsWith('/health') ? { ok: !!process && process.exitCode === null }
      : String(url).endsWith('/lora-adapters') ? { ok: true, json: async () => [] }
        : new Response(new ReadableStream({ start(controller) { end = () => controller.close(); } })) });
  const response = await runtime.proxyChatCompletion({ messages: [], stream: true });
  assert.equal(resources.status().active.filter(e => e.kind !== 'residency').length, 1);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(process.exitCode, null, 'idle shutdown must not interrupt a proxied stream');
  end(); await response.text();
  assert.equal(resources.status().active.filter(e => e.kind !== 'residency').length, 0);
  const cancelled = await runtime.proxyChatCompletion({ messages: [], stream: true });
  await cancelled.body.cancel();
  assert.equal(process.exitCode, 0);
  assert.equal(resources.status().active.length, 0);
  runtime.stop();
});

test('foreground use promotes a warm start even before its first queued event', async t => {
  const resources = coordinator(t);
  const interactive = await resources.acquire({ owner: 'interactive turn', estimate: {} });
  let process;
  const runtime = createOnDemandProcess({ name: 'warm model', command: () => ({ bin: 'fake', args: [] }),
    healthUrl: () => 'fake', idleMs: () => 0, platform: 'linux', resourceCoordinator: resources,
    resourceEstimate: () => ({ ramMb: 100 }), fetch: async () => ({ ok: !!process }),
    spawn: () => (process = child(456)) });
  const warm = runtime.ensure({ background: true });
  const foreground = runtime.use(() => 'ready');
  assert.equal(await foreground, 'ready');
  await warm;
  interactive.release(); runtime.stop();
  assert.equal(resources.status().active.length, 0);
});

test('analysis releases reservations on successful cleanup but retains failed cleanup', async t => {
  const resources = coordinator(t);
  const run = cleanupFails => runAnalysisSandbox({ code: 'print(1)' }, { platform: 'win32', resourceCoordinator: resources,
    runProcess: async (_bin, args) => args[0] === '--cleanup' ? { code: cleanupFails ? 1 : 0, errors: 'cleanup failed' }
      : { code: 0, output: '{"logs":"1","charts":[]}', errors: '' } });
  await run(false);
  assert.equal(resources.status().active.length, 0);
  await assert.rejects(run(true), /cleanup failed/);
  assert.equal(resources.status().active.length, 1);
});

function bridgeFixture(t, inspect) {
  const resources = coordinator(t);
  const handlers = new Map();
  let process = { ProcessId: 987, ParentProcessId: 654, CreationDate: 'original' };
  const bridge = registerNativeResourceRoutes({ app: { post: (url, fn) => handlers.set(url, fn) }, coordinator: resources,
    checkAuth: (req, res) => { if (!req.auth) { res.status(403).json({ error: 'forbidden' }); return false; } return true; },
    launcherPid: 654, inspect: inspect || (async () => process), pollMs: 5 });
  t.after(() => bridge.close());
  async function call(action, body = {}, auth = true) {
    const response = new EventEmitter(); response.code = 200;
    response.status = code => { response.code = code; return response; };
    response.json = result => { response.body = result; response.writableEnded = true; };
    await handlers.get(`/resources/native/${action}`)({ body, auth }, response);
    return { code: response.code, body: response.body };
  }
  return { resources, call, bridge, set: value => { process = value; } };
}

test('native handoff requires authentication and verified launcher ownership', async t => {
  const { call, set, resources } = bridgeFixture(t);
  assert.equal((await call('reserve', { service: 'fish-speech' }, false)).code, 403);
  const reservation = await call('reserve', { service: 'fish-speech' });
  const id = reservation.body.id;
  set({ ProcessId: 987, ParentProcessId: 111, CreationDate: 'original' });
  assert.equal((await call('attach', { id, pid: 987 })).code, 409);
  assert.equal((await call('release', { id })).code, 409);
  assert.equal(resources.status().active.length, 1);
  assert.equal((await call('release', { id, notStarted: true })).code, 200);
  assert.equal(resources.status().active.length, 0);
});

test('native process exit, not a release request, frees capacity; recovery is idempotent', async t => {
  const { call, set, resources } = bridgeFixture(t);
  const first = await call('recover', { service: 'fish-speech', pid: 987 });
  const second = await call('recover', { service: 'fish-speech', pid: 987 });
  assert.equal(first.body.id, second.body.id);
  assert.equal(resources.status().active.length, 1);
  assert.equal((await call('release', { id: first.body.id })).code, 409);
  set(null);
  assert.equal((await call('release', { id: first.body.id })).code, 200);
  assert.equal(resources.status().active.length, 0);
});

test('native Fish residency follows confirmed device moves and failed moves retain capacity', async t => {
  const { resources, call, bridge, set } = bridgeFixture(t);
  await call('recover', { service: 'fish-speech', pid: 987 });
  const park = await resources.acquire({ owner: 'park', estimate: { ramMb: 5120 } });
  bridge.finishFishTransfer(park, 'cpu', true); park.release();
  assert.equal(resources.status().active[0].estimate.vramMb, 0);
  assert.equal(resources.status().active[0].estimate.ramMb, 5120);
  const restore = await resources.acquire({ owner: 'restore', estimate: { vramMb: 5120 } });
  bridge.finishFishTransfer(restore, 'cuda', true); restore.release();
  assert.equal(resources.status().active[0].estimate.vramMb, 5120);
  const failed = await resources.acquire({ owner: 'failed park', estimate: { ramMb: 5120 } });
  bridge.finishFishTransfer(failed, 'cpu', false); failed.release();
  assert.equal(resources.status().active.length, 2);
  set(null);
  await call('release', { id: resources.status().active[0].id });
  assert.equal(resources.status().active.length, 0);
});

test('failed owned inference keeps CPU capacity until actual process termination', async t => {
  const resources = coordinator(t);
  let process, exit;
  const runtime = createOnDemandProcess({ name: 'owned inference', command: () => ({ bin: 'fake', args: [] }),
    healthUrl: () => 'fake', idleMs: () => 0, platform: 'linux', resourceCoordinator: resources,
    resourceEstimate: () => ({ ramMb: 100 }), fetch: async () => ({ ok: !!process }),
    spawn: () => { process = child(567); exit = process.kill; process.kill = () => true; return process; } });
  await assert.rejects(runtime.use(() => { throw new Error('request failed'); }, { estimate: { cpu: 4 } }), /request failed/);
  assert.equal(resources.status().active.length, 2);
  exit();
  assert.equal(resources.status().active.length, 0);
});

test('resource contention does not put a healthy on-demand binary into a failure cooldown', async t => {
  let process, attempts = 0;
  const resources = coordinator(t);
  const coordinatorProxy = { acquire: async request => {
    if (++attempts === 1) throw Object.assign(new Error('queued too long'), { code: 'RESOURCE_WAIT_TIMEOUT' });
    return resources.acquire(request);
  } };
  const runtime = createOnDemandProcess({ name: 'contended model', command: () => ({ bin: 'fake', args: [] }),
    healthUrl: () => 'fake', idleMs: () => 0, platform: 'linux', resourceCoordinator: coordinatorProxy,
    resourceEstimate: () => ({ ramMb: 100 }), fetch: async () => ({ ok: !!process }),
    spawn: () => (process = child(789)) });
  await assert.rejects(runtime.ensure(), /queued too long/);
  await runtime.ensure();
  assert.equal(attempts, 2);
  runtime.stop();
});

test('concurrent native handoffs cannot overwrite the process tracked by one reservation', async t => {
  const { resources, call } = bridgeFixture(t, async pid => ({ ProcessId: pid, ParentProcessId: 654, CreationDate: 'original' }));
  const reserved = await call('reserve', { service: 'fish-speech' });
  const results = await Promise.all([call('attach', { id: reserved.body.id, pid: 987 }), call('attach', { id: reserved.body.id, pid: 988 })]);
  assert.deepEqual(results.map(result => result.code).sort(), [200, 409]);
  assert.equal(resources.status().active.length, 1);
  assert.equal(resources.status().active[0].pid, 987);
});

test('cancelled chat retains inference capacity until its owned process actually exits', async t => {
  const resources = coordinator(t);
  const controller = new AbortController();
  let process, entered = false;
  const runtime = createLlamaServerRuntime({ resourceCoordinator: resources, platform: 'linux', threads: 4,
    env: { LLAMA_SERVER_BIN: 'C:\\llama\\llama-server.exe', LLAMA_MODEL: 'C:\\models\\mana.gguf', LLAMA_SERVER_IDLE_MS: '0' },
    fs: { existsSync: () => true, statSync: () => ({ size: 1024 * 1048576, isFile: () => true }) },
    probeHelp: () => '--device --cache-ram', registerExitHandlers: false, sleep: tick,
    spawn: () => {
      process = child(890);
      const exit = process.kill;
      process.kill = () => { setTimeout(exit, 30); return true; };
      return process;
    },
    fetch: async (url, options) => String(url).endsWith('/health') ? { ok: !!process && process.exitCode === null }
      : String(url).endsWith('/lora-adapters') ? { ok: true, json: async () => [] }
        : new Promise((_resolve, reject) => { entered = true; options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); }) });
  const messages = []; messages.signal = controller.signal;
  const reply = runtime.runLocalAssistantReply('hello', 8, 'default', null, messages);
  const rejected = assert.rejects(reply, /cancelled/);
  while (!entered) await tick();
  controller.abort(new Error('cancelled'));
  await tick();
  assert.equal(process.exitCode, null);
  assert.ok(resources.status().active.some(e => e.estimate.cpu === 4 && e.pid === 890));
  await rejected;
  assert.equal(process.exitCode, 0);
  assert.equal(resources.status().active.length, 0);
});

test('tool rounds restore their adapter after interactive chat runs at a safe boundary', async t => {
  const resources = coordinator(t);
  let process, adapter, completions = 0;
  const observed = [];
  const runtime = createLlamaServerRuntime({ resourceCoordinator: resources, platform: 'linux',
    env: { LLAMA_SERVER_BIN: 'C:\\llama\\llama-server.exe', LLAMA_MODEL: 'C:\\models\\mana.gguf', LLAMA_SERVER_IDLE_MS: '0' },
    fs: { existsSync: () => true, statSync: () => ({ size: 1024 * 1048576, isFile: () => true }) },
    probeHelp: () => '--device --cache-ram', registerExitHandlers: false, sleep: tick,
    spawn: () => (process = child(901)),
    fetch: async (url, options) => {
      if (String(url).endsWith('/health')) return { ok: !!process && process.exitCode === null };
      if (String(url).endsWith('/lora-adapters')) {
        if (options?.method === 'POST') {
          adapter = JSON.parse(options.body).find(item => item.scale === 1)?.id;
          return { ok: true, json: async () => ({}) };
        }
        return { ok: true, json: async () => [{ id: 1, path: 'companion.gguf' }, { id: 2, path: 'assistant.gguf' }] };
      }
      observed.push(adapter); completions += 1;
      return { ok: true, json: async () => ({ choices: [{ message: completions === 1
        ? { tool_calls: [{ id: 'call', type: 'function', function: { name: 'work', arguments: '{}' } }] }
        : { content: 'hello' } }] }) };
    } });
  await runtime.runToolAwareReply('Do work.', { tools: [{ type: 'function', function: { name: 'work', parameters: { type: 'object', properties: {} } } }],
    executeTool: async () => { await runtime.runLocalAssistantReply('Chat during tools.', 8); return 'done'; } }, { maxRounds: 2 });
  assert.deepEqual(observed, [2, 1, 2]);
  runtime.stop();
  assert.equal(resources.status().active.length, 0);
});
