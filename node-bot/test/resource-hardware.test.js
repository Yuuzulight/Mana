const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createResourceCoordinator } = require('../utils/resource-coordinator');
const { createHardwareTelemetry } = require('../utils/resource-service');
const { createLlamaServerRuntime } = require('../ai/llama-server-runtime');
const { runSandboxedTestCommand } = require('../tools/native-execution');
const { waitForExit } = require('../utils/kill-process-tree');

test('live GPU chat overlaps an AppContainer test and releases owned processes', {
  skip: process.platform !== 'win32' || process.env.MANA_TEST_RESOURCE_LIVE !== '1', timeout: 180000,
}, async t => {
  const bin = process.env.MANA_TEST_LLAMA_BIN;
  const model = process.env.MANA_TEST_LLAMA_MODEL;
  assert.ok(bin && model && fs.existsSync(bin) && fs.existsSync(model), 'explicit local fixture paths are required');
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const telemetry = createHardwareTelemetry();
  const before = await telemetry([]);
  assert.ok(Number.isFinite(before.vramFreeMb), 'live GPU telemetry must be available');
  const resources = createResourceCoordinator({ telemetry });
  const processes = [];
  const runtime = createLlamaServerRuntime({ resourceCoordinator: resources, registerExitHandlers: false,
    env: { ...process.env, LLAMA_MODEL: model, LLAMA_SERVER_BIN: bin, LLAMA_SERVER_PORT: String(port),
      LLAMA_CONTEXT: '512', LLAMA_THREADS: '4', LLAMA_NGL: '99', LLAMA_SERVER_IDLE_MS: '0', LLAMA_CACHE_RAM: '0',
      LLAMA_SPEC_DRAFT_MODEL: '', LLAMA_PARALLEL: '1' },
    spawn: (...args) => { const child = spawn(...args); processes.push(child); return child; } });
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-resource-live-'));
  let tests;
  t.after(async () => {
    runtime.stop();
    for (const child of processes) await waitForExit(child, 'live fixture');
    if (tests) await tests.catch(() => {});
    resources.close(); fs.rmSync(source, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(source, 'overlap.test.js'), "require('node:test')('overlap',async()=>{await new Promise(r=>setTimeout(r,8000));});");
  const first = await runtime.runLocalAssistantReply('Say hello.', 8, 'default', 'Reply briefly.');
  assert.ok(first.trim());
  let settled = false;
  tests = runSandboxedTestCommand('node --test overlap.test.js', source, { resourceCoordinator: resources,
    copySources: { dependencyRoots: [], nugetRoot: null } });
  tests.then(() => { settled = true; }, () => { settled = true; });
  const deadline = Date.now() + 30000;
  while (!resources.status().active.some(e => e.owner === 'Workspace tests' && e.pid)) {
    if (settled) await tests;
    assert.ok(!settled && Date.now() < deadline, 'sandbox must become active before overlap check');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const second = await runtime.runLocalAssistantReply('Say hello again.', 8, 'default', 'Reply briefly.');
  assert.ok(second.trim());
  assert.ok(!settled, 'chat proceeds while the approved sandbox test continues');
  const result = await tests;
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.ok(!resources.status().active.some(e => e.owner === 'Workspace tests'));
  runtime.stop();
  for (const child of processes) {
    assert.equal(await waitForExit(child, 'live fixture'), true);
    assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
  }
  assert.equal(resources.status().active.length, 0);
  const after = await telemetry([]);
  t.diagnostic(JSON.stringify({ before, after, ownedPids: processes.map(child => child.pid), allOwnedProcessesExited: true }));
});
