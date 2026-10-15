const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

function resolveArcanaPath(env = process.env, fsLike = fs) {
  const explicit = env.MANA_ARCANA_EXECUTABLE_PATH;
  if (explicit) return explicit;
  const bundled = path.resolve(__dirname, '../../node-bot/runtime/arcana/Arcana.Cli.dll');
  if (fsLike.existsSync(bundled)) return bundled;
  // Developer checkouts may keep Arcana beside Mana (including isolated worktrees).
  for (let directory = path.resolve(__dirname, '../..'); ; directory = path.dirname(directory)) {
    for (const configuration of ['Release', 'Debug']) {
      const candidate = path.join(directory, 'Arcana/src/Arcana.Cli/bin', configuration, 'net10.0/Arcana.Cli.dll');
      if (fsLike.existsSync(candidate)) return candidate;
    }
    if (path.dirname(directory) === directory) break;
  }
  return null;
}

async function stopTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'close').catch(() => {});
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    await once(killer, 'close');
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  await Promise.race([ended, delay(3000, undefined, { ref: false })]);
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') throw new Error('Arcana did not exit after process-tree cleanup');
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await ended;
  }
}

function claimProfile(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'mana-arcana.lock');
  const ticket = JSON.stringify({ pid: process.pid, nonce: randomBytes(16).toString('hex') });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, ticket, { flag: 'wx', mode: 0o600 });
      return () => {
        if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === ticket) fs.unlinkSync(file);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Arcana profile lock is invalid');
      try { process.kill(owner.pid, 0); }
      catch (probe) {
        if (probe.code === 'ESRCH' && attempt === 0) { fs.unlinkSync(file); continue; }
        throw new Error('Arcana profile is locked by another session');
      }
      throw new Error('Arcana profile is already in use by another session');
    }
  }
  throw new Error('Arcana profile could not be locked');
}

function createArcanaBrowserType({ chromium, env = process.env }) {
  return {
    async launchPersistentContext(profileDirectory, options = {}) {
      if (options.headless === false) throw new Error('Arcana manual control is inside Mana: use Take over in the Browser panel');
      const executable = options.executablePath || resolveArcanaPath(env);
      if (!executable || !path.isAbsolute(executable) || !fs.existsSync(executable))
        throw new Error('Arcana is not installed: run tools/install-arcana.ps1 or set MANA_ARCANA_EXECUTABLE_PATH to its CLI');
      if (!path.isAbsolute(profileDirectory)) throw new Error('Arcana profile directory must be absolute');
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-arcana-'));
      let releaseProfile;
      try { releaseProfile = claimProfile(profileDirectory); }
      catch (error) { fs.rmSync(temporary, { recursive: true, force: true }); throw error; }
      // These basenames also trigger Mana's existing read/upload credential guards.
      const stateFile = path.join(profileDirectory, 'credentials.json');
      const readyFile = path.join(temporary, 'ready.json');
      const token = randomBytes(32).toString('hex');
      const args = /\.dll$/i.test(executable) ? [executable] : [];
      args.push('serve', '--host', '127.0.0.1', '--port', '0', '--workers', '1', '--max-connections', '16',
        '--storage-dir', profileDirectory, '--ready-file', readyFile);
      if (env.MANA_ARCANA_ALLOW_PRIVATE_NETWORK === '1') args.push('--allow-private-network');
      const child = spawn(/\.dll$/i.test(executable) ? (env.MANA_DOTNET_PATH || 'dotnet') : executable, args, {
        windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...env, OBSCURA_CDP_TOKEN: token, OBSCURA_ALLOW_PRIVATE_NETWORK: env.MANA_ARCANA_ALLOW_PRIVATE_NETWORK === '1' ? '1' : '0' },
      });
      let failed = null;
      let diagnostics = '';
      child.on('error', error => { failed = error; });
      child.stdout.resume();
      child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-2000); });
      let browser;
      let context;
      let closing;
      const close = () => closing ||= (async () => {
        try {
          if (browser?.isConnected()) {
            try {
              if (context) {
                // The pinned Obscura revision persists localStorage in the profile;
                // sessionStorage remains scoped to this tab.
                const state = { cookies: await context.cookies(), origins: [] };
                const pending = path.join(profileDirectory, `.env.arcana-state-${randomBytes(8).toString('hex')}`);
                fs.writeFileSync(pending, JSON.stringify(state), { mode: 0o600 });
                fs.renameSync(pending, stateFile);
              }
            } finally { await browser.close(); }
          }
        }
        finally {
          await stopTree(child);
          releaseProfile();
          fs.rmSync(temporary, { recursive: true, force: true });
        }
      })();
      try {
        const deadline = Date.now() + 15000;
        let ready;
        while (!ready) {
          if (failed) throw failed;
          if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Arcana exited during startup: ${diagnostics}`);
          if (Date.now() >= deadline) throw new Error('Arcana did not publish its CDP endpoint within 15 seconds');
          try { ready = JSON.parse(fs.readFileSync(readyFile, 'utf8')); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (!ready) await delay(25);
        }
        if (ready.host !== '127.0.0.1' || !Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535 || ready.websocket_path !== '/devtools/browser')
          throw new Error('Arcana published an invalid loopback endpoint');
        browser = await chromium.connectOverCDP(`ws://127.0.0.1:${ready.port}/devtools/browser`, {
          timeout: 15000, headers: { Authorization: `Bearer ${token}` },
        });
        context = await browser.newContext(fs.existsSync(stateFile) ? { storageState: stateFile } : {});
        child.once('exit', () => { void close().catch(() => {}); });
        browser.once('disconnected', () => { void close().catch(() => {}); });
        return new Proxy(context, {
          get(target, property) {
            if (property === 'close') return close;
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      } catch (error) {
        await close();
        throw error;
      }
    },
  };
}

module.exports = { resolveArcanaPath, createArcanaBrowserType };
