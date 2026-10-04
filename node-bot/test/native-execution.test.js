const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareTestExecution, prepareTestExecutionAsync, launchNativeProcess, runSandboxedTestCommand, copyTree, parseArgs } = require('../tools/native-execution');

test('Terminal Stop cancels workspace setup without starting the test process', { skip: process.platform !== 'win32' }, async t => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-stop-setup-'));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  fs.writeFileSync(path.join(source, 'never.js'), "require('node:fs').writeFileSync('should-not-exist', 'ran');");
  const feed = require('../terminal-feed').terminalFeed;
  const running = runSandboxedTestCommand('node never.js', source);
  const rejected = assert.rejects(running, /stopped/);
  await new Promise(resolve => setImmediate(resolve));
  const setup = feed.list().find(run => run.cwd === source && run.running);
  assert.ok(setup);
  assert.deepEqual(feed.stop(setup.id), { stopped: true });
  await rejected;
  assert.equal(feed.get(setup.id).running, false);
  assert.equal(fs.existsSync(path.join(source, 'should-not-exist')), false);
});

test('workspace preparation runs off-thread and removes cancelled scratch', async t => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-copy-worker-'));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  fs.writeFileSync(path.join(source, 'test.js'), '');
  const prepared = await prepareTestExecutionAsync('node test.js', source, 'standard');
  t.after(() => fs.rmSync(prepared.work, { recursive: true, force: true }));
  assert.equal(fs.existsSync(path.join(prepared.work, 'workspace', 'test.js')), true);
  const before = new Set(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('Mana.Execution.')));
  let checks = 0;
  await assert.rejects(prepareTestExecutionAsync('node test.js', source, 'standard', { cancelled: () => ++checks > 1 }), /stopped/);
  assert.deepEqual(new Set(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('Mana.Execution.'))), before);
});

test('native argument adapter preserves quoted paths and rejects shell operators', () => {
  assert.deepEqual(parseArgs('--test "test/a b.test.js"'), ['--test', 'test/a b.test.js']);
  for (const command of ['a && b', 'a | b', '"unclosed', 'a\nb']) assert.throws(() => parseArgs(command), /Shell|quoting/);
});

test('disposable copies exclude credentials and refuse links outside approved sources', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-copy-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'safe.js'), 'safe'); fs.writeFileSync(path.join(source, '.env'), 'secret');
  for (const name of ['.npmrc', '.yarnrc.yml', 'NuGet.Config', '.netrc', 'pip.ini']) fs.writeFileSync(path.join(source, name), 'host-credential');
  const copied = path.join(root, 'copy'); copyTree(source, copied, { exclude: true });
  assert.equal(fs.readFileSync(path.join(copied, 'safe.js'), 'utf8'), 'safe');
  assert.equal(fs.existsSync(path.join(copied, '.env')), false);
  for (const name of ['.npmrc', '.yarnrc.yml', 'NuGet.Config', '.netrc', 'pip.ini']) assert.equal(fs.existsSync(path.join(copied, name)), false);
  const runtimeCopy = path.join(root, 'runtime-copy');
  copyTree(source, runtimeCopy);
  assert.equal(fs.existsSync(path.join(runtimeCopy, '.npmrc')), false);
  assert.equal(fs.existsSync(path.join(runtimeCopy, '.env')), false);
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(source, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => copyTree(source, path.join(root, 'bad')), /approved source/);
});

test('runtime and workspace copies share a single storage budget', t => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-copy-budget-'));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  const input = path.join(source, 'input');
  fs.writeFileSync(input, '1234');
  const budget = { entries: 0, bytes: 8 * 1024 ** 3 - 6 };
  copyTree(input, path.join(source, 'first'), { budget });
  assert.throws(() => copyTree(input, path.join(source, 'second'), { budget }), /size budget/);
  assert.equal(fs.existsSync(path.join(source, 'second')), false);
});

test('workspace copies refuse to recursively copy their own scratch', t => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-copy-recursion-'));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  const work = path.join(source, 'scratch');
  fs.mkdirSync(work);
  assert.throws(() => prepareTestExecution('node test.js', source, 'standard', { work }), /outside the copied workspace/);
  assert.equal(fs.existsSync(work), false);
});

test('live native runner: focused Node test and scratch cleanup', { skip: process.platform !== 'win32' || process.env.MANA_TEST_NATIVE_LIVE !== '1', timeout: 15000 }, async t => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-native-fixture-'));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  fs.writeFileSync(path.join(source, 'simple.test.js'), "require('node:test')('works',()=>require('node:assert/strict').equal(2+2,4));");
  const { work, request } = prepareTestExecution('node --test simple.test.js', source, 'standard');
  const child = launchNativeProcess(work, request);
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 5000);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  clearTimeout(timer);
  assert.equal(code, 0, output);
  assert.match(output, /pass 1/);
  assert.equal(fs.existsSync(work), false);
});

test('live native runner: sequential suite keeps separate processes inside the job', { skip: process.platform !== 'win32' || process.env.MANA_TEST_NATIVE_LIVE !== '1', timeout: 15000 }, async t => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-native-suite-'));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  fs.mkdirSync(path.join(source, 'test'));
  fs.copyFileSync(path.join(__dirname, '..', 'run_tests.js'), path.join(source, 'run_tests.js'));
  for (const name of ['a', 'b']) fs.writeFileSync(path.join(source, 'test', `${name}.test.js`), "require('node:test')('isolated',()=>{require('node:assert/strict').equal(global.previous,undefined); global.previous=true;});");
  const { work, request } = prepareTestExecution('node run_tests.js', source, 'standard');
  const child = launchNativeProcess(work, request);
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 7000);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  clearTimeout(timer);
  assert.equal(code, 0, output);
  assert.match(output, /All test files passed/);
  assert.equal(fs.existsSync(work), false);
});

test('live native runner normalizes Windows short-form temporary paths', { skip: process.platform !== 'win32' || process.env.MANA_TEST_NATIVE_LIVE !== '1', timeout: 15000 }, async t => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'mana path normalization '));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mana short temp path '));
  const original = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  t.after(() => {
    for (const [name, value] of Object.entries(original)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(temp, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(source, 'check.js'), "console.log('normalized')");
  const short = require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-Command', '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:MANA_TEST_SHORT_ROOT).ShortPath'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, MANA_TEST_SHORT_ROOT: temp } }).trim();
  process.env.TEMP = short;
  process.env.TMP = short;
  const { work, request } = prepareTestExecution('node check.js', source, 'standard');
  const child = launchNativeProcess(work, request);
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  child.stdin.end();
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(await done, 0, output);
  assert.match(output, /normalized/);
  assert.equal(fs.existsSync(work), false);
});

test('live native runner denies private files and networking', { skip: process.platform !== 'win32' || process.env.MANA_TEST_NATIVE_LIVE !== '1', timeout: 15000 }, async t => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-native-boundary-'));
  const secret = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-private-canary-'));
  t.after(() => { fs.rmSync(source, { recursive: true, force: true }); fs.rmSync(secret, { recursive: true, force: true }); });
  const canary = path.join(secret, 'canary.txt');
  fs.writeFileSync(canary, 'must not be readable');
  const server = require('node:net').createServer(socket => { socket.destroy(); assert.fail('Sandbox reached the host network'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  fs.writeFileSync(path.join(source, 'boundary.js'), `
    const assert = require('node:assert/strict');
    assert.throws(() => require('node:fs').readFileSync(${JSON.stringify(canary)}), /EPERM|EACCES/);
    const socket = require('node:net').connect(${server.address().port}, '127.0.0.1');
    socket.once('connect', () => process.exit(2));
    socket.once('error', () => { console.log('boundary denied'); process.exit(0); });
    setTimeout(() => process.exit(3), 2000);
  `);
  const { work, request } = prepareTestExecution('node boundary.js', source, 'standard');
  const child = launchNativeProcess(work, request);
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 5000);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  clearTimeout(timer);
  assert.equal(code, 0, output);
  assert.match(output, /boundary denied/);
  assert.equal(fs.existsSync(work), false);
});

test('live native runner kills descendants on completion and Stop', { skip: process.platform !== 'win32' || process.env.MANA_TEST_NATIVE_LIVE !== '1', timeout: 20000 }, async t => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-native-descendants-'));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  for (const stop of [false, true]) {
    fs.writeFileSync(path.join(source, 'children.js'), `
      require('node:child_process').spawn(process.execPath, ['-e', "console.log('descendant:' + process.pid); setInterval(()=>{},1000)"], { stdio: 'inherit', detached: true });
      ${stop ? 'setInterval(()=>{},1000);' : 'setTimeout(()=>process.exit(0),1500);'}
    `);
    const { work, request } = prepareTestExecution('node children.js', source, 'standard');
    const child = launchNativeProcess(work, request);
    let output = '';
    let descendant;
    child.stdout.on('data', data => {
      output += data;
      const match = /descendant:(\d+)/.exec(output);
      if (match && !descendant) { descendant = Number(match[1]); if (stop) child.kill(); }
    });
    child.stderr.on('data', data => { output += data; });
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 6000);
    await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    clearTimeout(timer);
    assert.ok(descendant, output);
    assert.throws(() => process.kill(descendant, 0), /ESRCH/);
    assert.equal(fs.existsSync(work), false);
  }
});

test('live native runner: offline .NET test fixture', { skip: process.platform !== 'win32' || process.env.MANA_TEST_NATIVE_DOTNET !== '1', timeout: 600000 }, async t => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-native-dotnet-'));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  for (const name of ['Fixture.csproj', 'Tests.cs']) fs.copyFileSync(path.join(__dirname, 'fixtures', 'native-dotnet', name), path.join(source, name));
  const { work, request } = await prepareTestExecutionAsync('dotnet test Fixture.csproj --verbosity quiet', source, 'large', {
    copySources: { dependencyRoots: [], nugetRoot: process.env.MANA_TEST_NUGET_CACHE || path.join(os.homedir(), '.nuget', 'packages') },
  });
  const child = launchNativeProcess(work, request);
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 60000);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  clearTimeout(timer);
  assert.equal(code, 0, output);
  assert.equal(fs.existsSync(work), false);
});

test('live unrestricted adapter retains disposable workspace and descendant cleanup', { skip: process.platform !== 'win32' || process.env.MANA_TEST_NATIVE_LIVE !== '1', timeout: 15000 }, async t => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-native-unrestricted-'));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  fs.writeFileSync(path.join(source, 'plain.test.js'), "require('node:test')('works',()=>require('node:assert/strict').equal(2+2,4));");
  const { work, request } = prepareTestExecution('node --test plain.test.js', source, 'standard', { unrestricted: true });
  assert.equal(request.mode, 'test-unrestricted');
  const child = launchNativeProcess(work, request);
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 7000);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  clearTimeout(timer);
  assert.equal(code, 0, output);
  assert.match(output, /pass 1/);
  assert.equal(fs.existsSync(work), false);
});

test('live helper cleans up after its owning backend is force-terminated', { skip: process.platform !== 'win32' || process.env.MANA_TEST_NATIVE_LIVE !== '1', timeout: 20000 }, async t => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-native-owner-'));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  fs.writeFileSync(path.join(source, 'owned.js'), "console.log('owned:' + process.pid); setInterval(()=>{},1000);");
  const diagnostic = path.join(source, 'helper-error.log');
  const controller = require('node:child_process').spawn(process.execPath, ['-e', `
    const native = require(${JSON.stringify(path.join(__dirname, '..', 'tools', 'native-execution'))});
    const prepared = native.prepareTestExecution('node owned.js', ${JSON.stringify(source)}, 'standard');
    console.log('work:' + prepared.work);
    const child = native.launchNativeProcess(prepared.work, prepared.request, { spawnImpl: (executable, args, options) => require('node:child_process').spawn(executable, args, { ...options, stdio: ['pipe', 'pipe', require('node:fs').openSync(${JSON.stringify(diagnostic)}, 'a')] }) });
    child.on('error', error => console.error(error.message));
    child.stdout.pipe(process.stdout); child.stdin.end();
  `], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => controller.kill());
  let output = '';
  let owned;
  let work;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { controller.kill(); reject(new Error(output || 'Owner fixture did not start')); }, 10000);
    controller.on('error', error => { clearTimeout(timer); reject(error); });
    controller.stderr.on('data', data => { output += data; });
    controller.stdout.on('data', data => {
      output += data;
      work = /work:([^\r\n]+)/.exec(output)?.[1];
      owned = Number(/owned:(\d+)/.exec(output)?.[1]);
      if (owned && work) { clearTimeout(timer); resolve(); }
    });
  });
  // Deliberately kill only the backend, leaving its helper to perform recovery.
  controller.kill();
  for (let i = 0; i < 100 && fs.existsSync(work); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(work), false, output + fs.readFileSync(diagnostic, 'utf8'));
  assert.throws(() => process.kill(owned, 0), /ESRCH/);
});
