const { spawn: defaultSpawn } = require("node:child_process");

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
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  // ready: our own child is up. An adopted server is health-checked on
  // every ensure() instead, so one that went away gets replaced.
  const state = { child: null, ready: false, starting: null, idleTimer: null, failedAt: 0 };
  let exitHandlerRegistered = false;

  function stop() {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
    state.ready = false;
    const child = state.child;
    state.child = null;
    if (child) {
      try {
        child.kill();
      } catch (e) {}
    }
  }

  // Restarts the idle countdown; call on every use.
  function touch() {
    const ms = idleMs();
    if (!ms || ms <= 0 || Number.isNaN(ms)) return;
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      if (state.child) console.log(`${name} idle for ${ms}ms, shutting it down`);
      stop();
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
    state.ready = true;
    touch();
    console.log(`${name} ready`);
  }

  async function start() {
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
