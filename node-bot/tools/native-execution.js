const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');
const { HELPER_PATH, runProcess } = require('./analysis-sandbox');
const { isCredentialPath } = require('../ai/tool-policy');
const { testProfile } = require('./test-resource-profile');

const COPY_SOURCES_PATH = path.join(__dirname, '..', 'data', 'native-sandbox-copy-sources.json');
function approvedCopySources() {
  if (!fs.existsSync(COPY_SOURCES_PATH)) return { dependencyRoots: [], nugetRoot: null };
  if (fs.statSync(COPY_SOURCES_PATH).size > 16384) throw new Error('Invalid sandbox copy-source configuration');
  const sources = JSON.parse(fs.readFileSync(COPY_SOURCES_PATH, 'utf8'));
  if (!Array.isArray(sources.dependencyRoots) || sources.dependencyRoots.length > 16
    || sources.dependencyRoots.some(root => typeof root !== 'string' || !path.isAbsolute(root))
    || (sources.nugetRoot != null && (typeof sources.nugetRoot !== 'string' || !path.isAbsolute(sources.nugetRoot)))) {
    throw new Error('Invalid sandbox copy-source configuration');
  }
  return { dependencyRoots: sources.dependencyRoots, nugetRoot: sources.nugetRoot || null };
}
const EXCLUDES = new Set(['.git', '.github', 'bin', 'obj', '.next', 'dist', 'out', 'target', 'tmp']);
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};

function copyTree(source, destination, { allowedRoots = [fs.realpathSync(source)], exclude = false, budget = { entries: 0, bytes: 0 } } = {}) {
  const walk = (from, to, ancestors, dependency = false) => {
    const real = fs.realpathSync(from);
    if (!allowedRoots.some(root => inside(root, real))) throw new Error(`Copy would leave the approved source: ${from}`);
    const stat = fs.statSync(real);
    if (++budget.entries > 500000 || (budget.bytes += stat.isFile() ? stat.size : 0) > 8 * 1024 ** 3) throw new Error('Disposable workspace copy exceeds its size budget');
    if (stat.isDirectory()) {
      if (ancestors.has(real)) throw new Error('Dependency link cycle');
      fs.mkdirSync(to, { recursive: true });
      const next = new Set([...ancestors, real]);
      for (const name of fs.readdirSync(real)) {
        const relative = path.relative(source, path.join(from, name)).replaceAll('\\', '/').toLowerCase();
        const packageTree = dependency || name.toLowerCase() === 'node_modules';
        if (exclude && (isCredentialPath(name) || (!packageTree && (EXCLUDES.has(name.toLowerCase()) || relative === 'data' || relative === 'node-bot/data')))) continue;
        walk(path.join(real, name), path.join(to, name), next, packageTree);
      }
    } else if (stat.isFile()) fs.copyFileSync(real, to);
    else throw new Error('Unsupported workspace entry');
  };
  walk(source, destination, new Set());
}

function newWork() {
  const work = path.join(os.tmpdir(), `Mana.Execution.${randomUUID().replaceAll('-', '')}`);
  fs.mkdirSync(work);
  return work;
}

function copyNode(work) {
  const runtime = path.join(work, 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  const executable = path.join(runtime, 'node.exe');
  fs.copyFileSync(process.execPath, executable);
  return executable;
}

// The helper inherits exactly stdin/out/err, not the backend's IPC or secret handles.
function launchNativeProcess(work, request, { helperPath = HELPER_PATH, spawnImpl = spawn, cleanup = runProcess } = {}) {
  if (process.platform !== 'win32') throw new Error('Windows AppContainer is required');
  if (!fs.existsSync(helperPath)) throw new Error('Native execution helper is unavailable; no unrestricted fallback');
  fs.writeFileSync(path.join(work, 'launch.json'), JSON.stringify(request));
  // The owner handle lets the helper finish cleanup after a backend crash.
  const helper = spawnImpl(helperPath, ['--process', work], { windowsHide: true, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MANA_SANDBOX_PARENT_PID: String(process.pid) } });
  const child = new EventEmitter();
  Object.assign(child, { pid: helper.pid, stdin: helper.stdin, stdout: helper.stdout, stderr: helper.stderr, exitCode: null, signalCode: null, cleanupRequired: true });
  child.kill = () => helper.kill();
  let launchError;
  helper.on('error', error => { launchError = error; });
  child.stdin?.on('error', error => child.emit('error', error));
  helper.on('close', async (code, signal) => {
    try {
      const result = await cleanup(helperPath, ['--process-cleanup', work], { timeoutMs: 20000 });
      if (result.code !== 0 || fs.existsSync(work)) throw new Error(`Native execution cleanup failed: ${result.errors || 'scratch remains'}`);
      if (launchError) { code = 1; child.emit('error', launchError); }
      child.exitCode = code;
      child.signalCode = signal;
      child.emit('exit', code, signal);
      child.emit('close', code, signal);
    } catch (error) {
      child.exitCode = 1;
      child.emit('error', error);
      child.emit('exit', 1);
      child.emit('close', 1);
    }
  });
  return child;
}

function nativeSkillWorker(workerPath, _args, _forkOptions) {
  const work = newWork();
  try {
    const executable = copyNode(work);
    const worker = path.join(work, 'worker.js');
    fs.copyFileSync(workerPath, worker);
    const child = launchNativeProcess(work, { executable, arguments: ['--preserve-symlinks', '--preserve-symlinks-main', worker, '--stdio'], cwd: work, profile: 'standard', mode: 'skill' });
    let buffered = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffered += chunk;
      if (buffered.length > 1048576) { child.kill(); child.emit('error', new Error('Skill protocol size limit exceeded')); return; }
      let newline;
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try { child.emit('message', JSON.parse(line)); }
        catch { child.kill(); child.emit('error', new Error('Invalid skill protocol message')); }
      }
    });
    child.send = message => {
      const line = `${JSON.stringify(message)}\n`;
      if (Buffer.byteLength(line) > 1048576) throw new Error('Skill result size limit exceeded');
      if (!child.stdin.destroyed) child.stdin.write(line);
    };
    return child;
  } catch (error) { fs.rmSync(work, { recursive: true, force: true }); throw error; }
}

function prepareTestExecution(command, cwd, profileId, { workspaceRoot = cwd, work, unrestricted = false, copySources = approvedCopySources() } = {}) {
  testProfile(profileId);
  work ||= newWork();
  try {
    const root = fs.realpathSync(workspaceRoot);
    const sourceCwd = fs.realpathSync(cwd);
    if (!inside(root, sourceCwd)) throw new Error('Test directory is outside the approved workspace');
    const roots = [root];
    for (const dependency of copySources.dependencyRoots) {
      if (fs.existsSync(dependency)) roots.push(fs.realpathSync(dependency));
    }
    const workspace = path.join(work, 'workspace');
    const budget = { entries: 4, bytes: fs.statSync(process.execPath).size + 65536 };
    copyTree(root, workspace, { allowedRoots: roots, exclude: true, budget });
    let executable = copyNode(work);
    let args;
    if (/^node\s/.test(command)) {
      args = parseArgs(command.slice(5));
      if (!unrestricted && args[0] === '--test') {
        if (args.length !== 2 || !/^[\w./\\ -]+\.test\.[cm]?js$/.test(args[1])) throw new Error('Native Node tests require one explicit file; use the sequential suite runner for multiple files');
        args.splice(1, 0, '--experimental-test-isolation=none');
      }
    }
    else if (/^npm\s/.test(command)) {
      const npm = path.join(path.dirname(process.execPath), 'node_modules', 'npm');
      if (!fs.existsSync(path.join(npm, 'bin', 'npm-cli.js'))) throw new Error('Bundled npm is unavailable');
      const copiedNpm = path.join(work, 'runtime', 'node_modules', 'npm');
      copyTree(npm, copiedNpm, { budget });
      args = [path.join(copiedNpm, 'bin', 'npm-cli.js'), ...parseArgs(command.slice(4))];
    } else if (/^dotnet\s/.test(command)) {
      const found = execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe'), ['dotnet.exe'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
      const runtime = path.join(work, 'dotnet');
      copyTree(path.dirname(found), runtime, { budget });
      if (!copySources.nugetRoot || !fs.existsSync(copySources.nugetRoot)) throw new Error('Approved offline NuGet package cache is unavailable');
      copyTree(copySources.nugetRoot, path.join(work, 'nuget-packages'), { budget });
      const config = path.join(work, 'nuget.config');
      fs.writeFileSync(config, '<configuration><packageSources><clear /></packageSources></configuration>');
      executable = path.join(runtime, 'dotnet.exe');
      args = parseArgs(command.slice(7));
      if (!['test', 'build'].includes(args[0])) throw new Error('Only dotnet build and test commands have a sandbox adapter');
      args.push('--disable-build-servers', '-m:1', '-p:UseSharedCompilation=false', `-p:RestoreConfigFile=${config}`);
    } else throw new Error('This test command has no native sandbox adapter; an unrestricted run requires separate approval');
    if (path.basename(executable).toLowerCase() === 'node.exe') args.unshift('--preserve-symlinks', '--preserve-symlinks-main');
    return { work, request: { executable, arguments: args, cwd: path.join(workspace, path.relative(root, sourceCwd)), profile: profileId, mode: unrestricted ? 'test-unrestricted' : 'test' } };
  } catch (error) { fs.rmSync(work, { recursive: true, force: true }); throw error; }
}

async function prepareTestExecutionAsync(command, cwd, profile, options = {}) {
  testProfile(profile);
  if (options.cancelled?.()) throw new Error('Sandbox test execution was stopped before setup');
  const work = newWork();
  let worker;
  let cancellation;
  let timeout;
  try {
    return await new Promise((resolve, reject) => {
      worker = new Worker(path.join(__dirname, 'native-execution-copy-worker.js'), {
        workerData: { command, cwd, profile, workspaceRoot: options.workspaceRoot || cwd, work, unrestricted: options.unrestricted === true, copySources: options.copySources || approvedCopySources() },
      });
      let prepared;
      let failure;
      worker.on('message', message => { prepared = message; });
      worker.on('error', error => { failure ||= error; });
      worker.on('exit', code => {
        if (options.cancelled?.()) failure ||= new Error('Sandbox test execution was stopped during setup');
        if (failure) reject(failure);
        else if (code !== 0 || !prepared) reject(new Error('Disposable workspace setup failed'));
        else resolve(prepared);
      });
      const stop = message => { failure ||= new Error(message); void worker.terminate(); };
      cancellation = setInterval(() => { if (options.cancelled?.()) stop('Sandbox test execution was stopped during setup'); }, 100);
      timeout = setTimeout(() => stop('Disposable workspace setup timed out'), testProfile(profile).timeoutMs);
    });
  } catch (error) {
    await worker?.terminate();
    await fs.promises.rm(work, { recursive: true, force: true });
    throw error;
  } finally { clearInterval(cancellation); clearTimeout(timeout); }
}

function parseArgs(command) {
  if (/[\r\n\0&|<>`]/.test(command)) throw new Error('Shell operators are not supported in sandbox test commands');
  const args = [];
  const pattern = /"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"']+)/g;
  let end = 0;
  for (const match of command.matchAll(pattern)) {
    if (command.slice(end, match.index).trim()) throw new Error('Invalid test command quoting');
    args.push(match[1] ?? match[2] ?? match[3]);
    end = match.index + match[0].length;
  }
  if (command.slice(end).trim()) throw new Error('Invalid test command quoting');
  return args;
}

let testQueue = Promise.resolve();
function runSandboxedTestCommand(command, cwd, options = {}) {
  const task = testQueue.then(async () => {
    if (options.cancelled?.()) throw new Error('Sandbox test execution was stopped before setup');
    const profile = testProfile(options.resourceProfile || 'standard');
    const startedAt = Date.now();
    let stopRequested = false;
    const cancelled = () => stopRequested || !!options.cancelled?.();
    const setup = require('../terminal-feed').terminalFeed.track({}, {
      ...options.terminal, command: `${command} [disposable workspace setup]`, cwd, kill: () => { stopRequested = true; },
    });
    let prepared;
    try {
      prepared = await prepareTestExecutionAsync(command, cwd, profile.id, { ...options, cancelled });
      if (cancelled()) { await fs.promises.rm(prepared.work, { recursive: true, force: true }); throw new Error('Sandbox test execution was stopped during setup'); }
      setup?.end(0);
    } catch (error) { setup?.end(1); throw error; }
    const { work, request } = prepared;
    let child;
    try { child = launchNativeProcess(work, request); }
    catch (error) { fs.rmSync(work, { recursive: true, force: true }); throw error; }
    const result = require('../ai/coding-tool-source').runTestCommand(command, cwd, {
      spawnImpl: () => child, killTree: () => child.kill(), timeoutMs: Math.max(1, profile.timeoutMs - (Date.now() - startedAt)),
      terminal: { ...options.terminal, kill: () => child.kill() },
    });
    child.stdin.end();
    let stopped = false;
    const cancellation = setInterval(() => {
      if (!stopped && cancelled()) { stopped = true; child.kill(); }
    }, 100);
    try {
      const completed = await result;
      if (stopped) throw new Error('Sandbox test execution was stopped; processes and scratch were cleaned up');
      return completed;
    } finally { clearInterval(cancellation); }
  });
  testQueue = task.catch(() => {});
  return task;
}

module.exports = { launchNativeProcess, nativeSkillWorker, prepareTestExecution, prepareTestExecutionAsync, runSandboxedTestCommand, copyTree, parseArgs, approvedCopySources };
