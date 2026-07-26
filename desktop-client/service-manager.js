// Spawns and health-checks the auxiliary local services Mana can use
// (Kokoro TTS, SearXNG web search), and polls the node-bot backend itself
// -- both for basic reachability and, since node-bot manages llama-server
// as its own child process rather than something desktop-client can spawn
// directly, for whether llama-server has come up too (see
// MANA_EAGER_LLAMA_SERVER in node-bot/server.js). Reports progress for each
// via a callback so main.js can forward it to the renderer's startup
// loading screen.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { resolvePythonEnv, fileExists } = require('./python-env');

async function pingOk(url, timeoutMs = 1500) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return resp.ok ? resp : null;
  } catch (e) {
    return null;
  }
}

async function waitForOk(url, { maxWaitMs = 45000, intervalMs = 800 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const resp = await pingOk(url);
    if (resp) return resp;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

function createServiceManager({ manaRoot, onProgress = () => {}, log = console, logFile = null }) {
  const children = {}; // id -> child process

  function emit(id, status, message) {
    onProgress({ id, status, message });
  }

  function logShutdownError(id, message) {
    log.error(`[${id}]`, message);
    logFile?.append(`[shutdown] ${id}: ${message}`);
  }

  function spawnAndTrack(id, command, args, options) {
    let child;
    try {
      child = spawn(command, args, options);
    } catch (e) {
      emit(id, 'failed', e.message);
      return null;
    }
    children[id] = child;
    child.stdout?.on('data', (d) => log.log(`[${id}]`, d.toString().trim()));
    child.stderr?.on('data', (d) => log.log(`[${id}]`, d.toString().trim()));
    child.once('exit', () => {
      if (children[id] === child) delete children[id];
    });
    return child;
  }

  // Waits for a child to exit on its own (after a graceful stop request),
  // force-killing it once maxWaitMs is up so the closing UI -- and the app
  // quitting -- is never blocked indefinitely by one hung process.
  function waitForExit(child, maxWaitMs) {
    return new Promise((resolve) => {
      if (!child || child.exitCode !== null) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch (e) {}
        resolve(false);
      }, maxWaitMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  async function startKokoro() {
    emit('kokoro', 'starting', 'Starting...');
    const dir = path.join(manaRoot, 'tts-service');
    const env = resolvePythonEnv(manaRoot, 'tts-service', 'tts-service');
    if (!env) {
      emit('kokoro', 'skipped', 'Not set up -- see tts-service/start.ps1.');
      return;
    }
    spawnAndTrack(
      'kokoro',
      env.uvicornExe,
      ['kokoro_service:app', '--host', '127.0.0.1', '--port', '5011'],
      { cwd: dir },
    );
    const ready = await waitForOk('http://127.0.0.1:5011/health');
    emit('kokoro', ready ? 'ready' : 'failed', ready ? 'Ready' : 'Timed out waiting for Kokoro to start.');
  }

  async function startSearxng() {
    emit('searxng', 'starting', 'Starting...');
    const dir = path.join(manaRoot, 'tools', 'searxng');
    const settingsPath = path.join(dir, 'mana-settings.yml');
    // A portable/venv Python env can exist without mana-settings.yml yet
    // having been copied in (e.g. a portable-python build with the source
    // tree's own mana-searxng-settings.yml still at its original spot) --
    // finish that one cheap step here instead of requiring a full
    // first-run-setup pass just to place a config file.
    if (!fileExists(settingsPath)) {
      const settingsSrc = path.join(manaRoot, 'tools', 'mana-searxng-settings.yml');
      if (fileExists(settingsSrc)) {
        try {
          fs.copyFileSync(settingsSrc, settingsPath);
        } catch (e) {}
      }
    }
    const env = resolvePythonEnv(manaRoot, 'searxng', path.join('tools', 'searxng'));
    if (!env || !fileExists(settingsPath)) {
      emit('searxng', 'skipped', 'Not set up -- see tools/setup-searxng.ps1.');
      return;
    }
    spawnAndTrack('searxng', env.pythonExe, ['-m', 'searx.webapp'], {
      cwd: dir,
      env: Object.assign({}, process.env, { SEARXNG_SETTINGS_PATH: settingsPath }),
    });
    const ready = await waitForOk('http://127.0.0.1:8890/');
    emit('searxng', ready ? 'ready' : 'failed', ready ? 'Ready' : 'Timed out waiting for SearXNG to start.');
  }

  // Doesn't spawn anything -- main.js's spawnBackend() already did. Just
  // reports when it's actually answering requests.
  async function waitForBackend() {
    emit('backend', 'starting', 'Starting...');
    const resp = await waitForOk('http://127.0.0.1:5005/health', { maxWaitMs: 60000 });
    emit('backend', resp ? 'ready' : 'failed', resp ? 'Ready' : 'Timed out waiting for the backend to start.');
    return resp;
  }

  // Same story: node-bot spawns llama-server itself once
  // MANA_EAGER_LLAMA_SERVER asks it to. This just watches node-bot's own
  // /health for that to finish.
  async function waitForLlamaServer() {
    emit('llama', 'starting', 'Waiting for a local model...');
    const startedAt = Date.now();
    const maxWaitMs = 120000;
    while (Date.now() - startedAt < maxWaitMs) {
      const resp = await pingOk('http://127.0.0.1:5005/health');
      if (resp) {
        try {
          const body = await resp.json();
          if (!body.llamaConfigured) {
            emit('llama', 'skipped', 'No local model configured -- see Settings.');
            return;
          }
          if (body.llamaServerRunning) {
            emit('llama', 'ready', 'Ready');
            return;
          }
        } catch (e) {
          // keep waiting
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    emit('llama', 'failed', 'Timed out waiting for llama-server to start.');
  }

  async function startAll() {
    const [backendResp] = await Promise.all([
      waitForBackend(),
      startKokoro(),
      startSearxng(),
    ]);
    if (backendResp) {
      await waitForLlamaServer();
    } else {
      emit('llama', 'skipped', 'Backend never came up.');
    }
  }

  // Kills a still-tracked child and waits (bounded) for it to actually
  // exit, reporting progress the same way startAll's steps do so the
  // closing UI can reuse the same row/status rendering.
  async function stopChild(id, label, maxWaitMs = 6000) {
    const child = children[id];
    if (!child || child.exitCode !== null) {
      emit(id, 'ready', 'Stopped');
      return;
    }
    emit(id, 'starting', `Unloading ${label}...`);
    try {
      child.kill();
    } catch (e) {
      logShutdownError(id, `kill() failed: ${e.message}`);
    }
    const exited = await waitForExit(child, maxWaitMs);
    if (exited) {
      emit(id, 'ready', 'Stopped');
    } else {
      logShutdownError(id, `did not exit within ${maxWaitMs}ms -- force killed`);
      emit(id, 'failed', 'Did not stop in time -- force killed.');
    }
  }

  // backend and llama-server are stopped together: node-bot's
  // POST /admin/shutdown releases llama-server's VRAM/RAM itself, then
  // exits. A plain kill() of backendProc alone would orphan llama-server.exe
  // -- Windows doesn't deliver a catchable signal via child_process.kill(),
  // so llama-server-runtime.js's own SIGTERM handler (the POSIX path) never
  // runs. If the graceful call fails or times out, fall back to a hard kill
  // so the app can still close, but log it -- an orphaned model process is
  // worth knowing about.
  async function stopBackendAndLlama(backendProc, { adminSecret, maxWaitMs = 8000 } = {}) {
    if (!backendProc || backendProc.exitCode !== null) {
      emit('backend', 'ready', 'Stopped');
      emit('llama', 'ready', 'Unloaded');
      return;
    }
    emit('backend', 'starting', 'Shutting down...');
    emit('llama', 'starting', 'Releasing model...');

    let requestedGracefully = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const headers = adminSecret ? { Authorization: `Bearer ${adminSecret}` } : undefined;
      const resp = await fetch('http://127.0.0.1:5005/admin/shutdown', {
        method: 'POST',
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);
      requestedGracefully = Boolean(resp && resp.ok);
      if (!requestedGracefully) {
        logShutdownError('backend', `/admin/shutdown responded ${resp ? resp.status : 'no response'}`);
      }
    } catch (e) {
      logShutdownError('backend', `/admin/shutdown request failed: ${e.message}`);
    }

    const exited = await waitForExit(backendProc, maxWaitMs);
    if (exited) {
      emit('backend', 'ready', 'Stopped');
      emit('llama', requestedGracefully ? 'ready' : 'failed', requestedGracefully ? 'Unloaded' : 'Stopped without confirming model release.');
      if (!requestedGracefully) {
        logShutdownError('llama', 'backend exited but graceful /admin/shutdown never confirmed -- llama-server may have been orphaned.');
      }
    } else {
      logShutdownError('backend', `did not exit within ${maxWaitMs}ms -- force killed`);
      emit('backend', 'failed', 'Did not stop in time -- force killed.');
      emit('llama', 'failed', 'Unknown -- backend had to be force killed.');
    }
  }

  async function stopAll(backendProc, opts = {}) {
    await Promise.all([
      stopBackendAndLlama(backendProc, opts),
      stopChild('kokoro', 'voice'),
      stopChild('searxng', 'web search'),
    ]);
  }

  return { startAll, stopAll };
}

module.exports = { createServiceManager };
