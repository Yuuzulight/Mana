const { spawn: defaultSpawn, execFile: defaultExecFile } = require("node:child_process");
const { killProcessTree, waitForExit } = require("./kill-process-tree");

// A local HTTP service started on first use and stopped after an idle
// period -- factored out of ai/reranker-runtime.js (#674/#721) so the
// on-demand Kokoro TTS (kokoro-runtime.js) shares it. Anything already
// answering healthUrl (left from a killed backend, or started by another
// launcher) is used as-is and never stopped; only a process this module
// spawned is.
//
// command() returns { bin, args, options } for spawn(), and may throw
// (e.g. the service isn't installed) -- that counts as a failed start.
function createOnDemandProcess({
  name,
  healthUrl,
  command,
  idleMs,
  startupTimeoutMs = 60 * 1000,
  // After a failed start, don't respawn on every call for a while, so a
  // broken setup isn't retried on every turn.
  retryCooldownMs = 5 * 60 * 1000,
  spawn = defaultSpawn,
  execFile = defaultExecFile,
  platform = process.platform,
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  // ready: our own child is up. An adopted server is health-checked on
  // every ensure() instead, so one that went away gets replaced.
  const state = { child: null, ready: false, starting: null, idleTimer: null, failedAt: 0 };
  // Settles once the last stopped child has exited (true) or is still
  // running after the stop bound (false); start() waits on it.
  let stopping = Promise.resolve(true);
  let exitHandlerRegistered = false;

  function stop() {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
    state.ready = false;
    const child = state.child;
    state.child = null;
    if (child) {
      killProcessTree(child, { platform, execFile });
      stopping = waitForExit(child, name);
    }
    return child;
  }

  // Restarts the idle countdown; call on every use.
  function touch() {
    const ms = idleMs();
    if (!ms || ms <= 0 || Number.isNaN(ms)) return;
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      // A timer left from before an unexpected exit must not kill the
      // restart in progress; that start's touch() schedules a fresh one.
      if (state.starting) return;
      const child = stop();
      if (!child) return; // adopted (not ours to stop) or already gone
      console.log(`${name} idle for ${ms}ms, shutting it down (pid ${child.pid})`);
      stopping.then((exited) => {
        if (exited) console.log(`${name} (pid ${child.pid}) stopped`);
      });
    }, ms);
    state.idleTimer.unref?.();
  }

  async function isHealthy() {
    try {
      // Bounded, so a wedged listener on the port can't hang the caller.
      const resp = await fetch(healthUrl(), { signal: AbortSignal.timeout(2000) });
      return Boolean(resp && resp.ok);
    } catch (e) {
      return false;
    }
  }

  async function spawnAndWait() {
    const { bin, args, options } = command();
    console.log(`Starting ${name}:`, bin, args.join(" "));
    const child = spawn(bin, args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      ...options,
    });
    let stderrTail = "";
    let exited = false;
    child.stderr?.on?.("data", (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-2000);
    });
    child.on("error", () => {
      exited = true;
    });
    child.on("exit", (code) => {
      exited = true;
      if (state.child === child) {
        state.child = null;
        state.ready = false;
        console.warn(`${name} exited (code ${code})`);
      }
    });
    state.child = child;
    if (!exitHandlerRegistered) {
      exitHandlerRegistered = true;
      process.once("exit", stop);
    }

    const startedAt = Date.now();
    while (!(await isHealthy())) {
      if (exited || Date.now() - startedAt > startupTimeoutMs) {
        stop();
        throw new Error(`${name} did not start: ${stderrTail.slice(-500) || "timed out"}`);
      }
      await sleep(500);
    }
    // stop() while that last health check was in flight (a game starting,
    // #760): the child is being killed, so it must not be marked ready.
    if (state.child !== child) throw new Error(`${name} was stopped while starting`);
    state.ready = true;
    touch();
    console.log(`${name} ready`);
  }

  async function start() {
    // A just-stopped child holds the port (and may still answer health)
    // until it has really exited; spawning before that fails to bind.
    await stopping;
    if (await isHealthy()) return;
    if (Date.now() - state.failedAt < retryCooldownMs) {
      throw new Error(`${name} failed to start recently, retrying later`);
    }
    try {
      await spawnAndWait();
    } catch (e) {
      state.failedAt = Date.now();
      throw e;
    }
  }

  // Resolves once the service answers; concurrent callers share one start.
  function ensure() {
    if (state.ready) return Promise.resolve();
    if (!state.starting) {
      state.starting = start().finally(() => {
        state.starting = null;
      });
    }
    return state.starting;
  }

  return { ensure, touch, stop };
}

module.exports = { createOnDemandProcess };
