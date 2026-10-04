const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { spawnNativeHelper } = require('../tools/native-helper-spawn');
const live = process.platform === 'win32' && process.env.MANA_TEST_NATIVE_LIVE === '1';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-helper-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'bundle'));
  const exe = path.join(root, 'bundle', 'node.exe');
  fs.copyFileSync(process.execPath, exe);
  fs.copyFileSync(path.join(__dirname, '../../tools/analysis-sandbox/publish-helper.ps1'), path.join(root, 'publish-helper.ps1'));
  const gate = path.join(root, 'helper-launch.lock');
  fs.mkdirSync(gate);
  fs.writeFileSync(path.join(gate, 'owner'), String(process.pid));
  return { root, exe, gate };
}

test('helper launch queues during deployment and can be cancelled without starting a process', { skip: !live }, async t => {
  const { root, exe, gate } = fixture(t);
  const marker = path.join(root, 'ran');
  const child = spawnNativeHelper(exe, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const done = new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
  await delay(200);
  assert.equal(child.pid, undefined);
  child.kill();
  await done;
  fs.rmSync(gate, { recursive: true });
  await delay(200);
  assert.equal(fs.existsSync(marker), false);
});

test('queued helper launches only after the publisher releases its gate', { skip: !live }, async t => {
  const { exe, gate } = fixture(t);
  const child = spawnNativeHelper(exe, ['-e', "console.log('ready')"], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  const done = new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
  child.stdin.end();
  await delay(200);
  assert.equal(child.pid, undefined);
  fs.rmSync(gate, { recursive: true });
  assert.equal(await done, 0);
  assert.match(output, /ready/);
  assert.equal(fs.existsSync(gate), false);
});

test('abandoned helper gates recover through the serialized publisher', { skip: !live, timeout: 15000 }, async t => {
  const { exe, gate } = fixture(t);
  const departed = spawn(process.execPath, ['-e', ''], { windowsHide: true });
  const deadPid = departed.pid;
  await new Promise(resolve => departed.once('close', resolve));
  fs.writeFileSync(path.join(gate, 'owner'), String(deadPid));
  const child = spawnNativeHelper(exe, ['-e', "console.log('recovered')"], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  const done = new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
  child.stdin.end();
  assert.equal(await done, 0);
  assert.match(output, /recovered/);
  assert.equal(fs.existsSync(gate), false);
});

test('helper launch retries a temporarily locked gate owner file', { skip: !live, timeout: 15000 }, async t => {
  const { exe, gate } = fixture(t);
  const ownerPath = path.join(gate, 'owner').replaceAll("'", "''");
  const locker = spawn('powershell', ['-NoProfile', '-Command', `$file=[IO.File]::Open('${ownerPath}',[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); try { [Console]::WriteLine('locked'); Start-Sleep -Milliseconds 1500 } finally { $file.Dispose() }`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const unlocked = new Promise((resolve, reject) => { locker.on('close', resolve); locker.on('error', reject); });
  t.after(async () => { locker.kill(); await unlocked.catch(() => {}); });
  await new Promise((resolve, reject) => { locker.stdout.once('data', resolve); locker.once('error', reject); });
  const child = spawnNativeHelper(exe, ['-e', "console.log('ready')"], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const done = new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
  t.after(async () => { child.kill(); await done.catch(() => {}); });
  child.stdout.resume(); child.stderr.resume(); child.stdin.end();
  await delay(300);
  assert.equal(child.pid, undefined);
  assert.equal(await unlocked, 0);
  fs.rmSync(gate, { recursive: true });
  assert.equal(await done, 0);
});

test('publisher waits for active sandbox scripts before replacing the helper', { skip: process.platform !== 'win32' || process.env.MANA_TEST_NATIVE_UPDATE !== '1', timeout: 90000 }, async t => {
  const native = require('../tools/native-execution');
  const { HELPER_PATH } = require('../tools/analysis-sandbox');
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-helper-publish-'));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  fs.writeFileSync(path.join(source, 'wait.js'), "console.log('ready'); const timer=setInterval(()=>{if(require('node:fs').existsSync('release')) clearInterval(timer);},100);");
  const prepared = native.prepareTestExecution('node wait.js', source, 'standard');
  const child = native.launchNativeProcess(prepared.work, prepared.request);
  const done = new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
  t.after(async () => { child.kill(); await done.catch(() => {}); });
  child.stdin.end();
  await new Promise(resolve => child.stdout.once('data', resolve));
  const before = fs.statSync(HELPER_PATH).mtimeMs;
  const root = path.dirname(path.dirname(HELPER_PATH));
  const publisher = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'publish-helper.ps1')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  publisher.stderr.on('data', data => { errors += data; });
  publisher.stdout.resume();
  const published = new Promise((resolve, reject) => { publisher.on('close', resolve); publisher.on('error', reject); });
  t.after(async () => { await published.catch(() => {}); });
  const gate = path.join(root, 'helper-launch.lock');
  for (let i = 0; i < 400 && !fs.existsSync(gate); i++) await delay(100);
  assert.equal(fs.existsSync(gate), true, errors);
  assert.equal(fs.statSync(HELPER_PATH).mtimeMs, before);
  await assert.rejects(require('../tools/script-runner').runToolScript('return 42;', { timeoutMs: 1000 }), /timed out/);
  fs.writeFileSync(path.join(prepared.request.cwd, 'release'), 'ready');
  assert.equal(await published, 0, errors);
  assert.equal(await done, 0);
  assert.equal(fs.existsSync(prepared.work), false);
  assert.equal(fs.existsSync(gate), false);
});
