function createServerStartup(context) {
function serverPort() {
    return Number(context.env.LLAMA_SERVER_PORT || 8090);
  }

async function isHealthy(port) {
    try {
      const resp = await context.fetchImpl(`http://127.0.0.1:${port}/health`);
      return Boolean(resp && resp.ok);
    } catch (e) {
      return false;
    }
  }

async function getRunningModelPath(port) {
    try {
      const resp = await context.fetchImpl(`http://127.0.0.1:${port}/props`);
      if (!resp || !resp.ok) return null;
      const props = await resp.json();
      return props && props.model_path ? String(props.model_path) : null;
    } catch (e) {
      return null;
    }
  }

function sameModelPath(a, b) {
    if (!a || !b) return false;
    try {
      return context.path.resolve(a).toLowerCase() === context.path.resolve(b).toLowerCase();
    } catch (e) {
      return String(a).toLowerCase() === String(b).toLowerCase();
    }
  }

async function startServer(model, mmproj = null, profile = null, signal = null) {
    context.state.lastStartBin = null;
    context.state.ctx = context.configuredContext();
    const bin = context.findLlamaServerBin();
    context.state.lastStartBin = bin;
    const port = serverPort();
    // A just-stopped server holds the port until it has really exited; a
    // new one spawned before that fails to bind, which #693 would count
    // against the build.
    await context.state.stopping;
    if (signal?.aborted && context.state.busy <= 1) signal.throwIfAborted();

    // If something already answers on the target port (e.g. a server left
    // over from a previous backend run), adopt it when it serves the same
    // model instead of failing to bind.
    if (await isHealthy(port)) {
      const runningModel = await getRunningModelPath(port);
      if (sameModelPath(runningModel, model)) {
        context.state.child = null;
        context.state.model = model;
        context.state.mmproj = mmproj;
        context.state.port = port;
        console.log(
          `Adopted existing llama-server on port ${port} (model: ${model})`,
        );
        context.registerExit();
        return;
      }
      throw new Error(
        `Port ${port} is already in use by another llama-server (model: ${runningModel || "unknown"}). Set LLAMA_SERVER_PORT to a free port.`,
      );
    }

    const args = context.buildServerArgs(model, port, mmproj, profile, bin);
    if (signal?.aborted && context.state.busy <= 1) signal.throwIfAborted();
    console.log("Starting llama-server:", bin, args.join(" "));
    const child = context.spawn(bin, args, {
      // bin always names a Windows llama-server.exe -- path.win32 so this
      // resolves the same way regardless of which OS Node itself is
      // running on (bin can come straight from LLAMA_SERVER_BIN unchanged).
      cwd: context.path.win32.dirname(bin),
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      env: context.buildServerEnv(),
    });

    let stderrTail = "";
    let exited = false;
    if (child.stderr && typeof child.stderr.on === "function") {
      child.stderr.on("data", (chunk) => {
        stderrTail = (stderrTail + String(chunk)).slice(-4000);
      });
    }
    child.on("error", () => {
      exited = true;
    });
    child.on("exit", (code) => {
      exited = true;
      if (context.state.child === child) {
        context.state.child = null;
        context.state.model = null;
        context.state.mmproj = null;
        context.state.port = null;
        console.warn(`llama-server exited unexpectedly (code ${code})`);
      }
    });

    context.state.child = child;
    context.state.port = port;

    const timeoutMs = Number(context.env.LLAMA_SERVER_STARTUP_TIMEOUT_MS || 180000);
    const startedWaitingAt = context.nowMs();
    for (;;) {
      if (signal?.aborted && context.state.busy <= 1) signal.throwIfAborted();
      if (exited) {
        context.stop();
        throw new Error(
          `llama-server exited during startup: ${stderrTail.slice(-1000)}`,
        );
      }
      if (await isHealthy(port)) {
        break;
      }
      if (context.nowMs() - startedWaitingAt > timeoutMs) {
        context.stop();
        throw new Error(
          `llama-server did not become healthy within ${timeoutMs}ms: ${stderrTail.slice(-1000)}`,
        );
      }
      await context.sleep(750);
    }

    context.state.model = model;
    context.state.mmproj = mmproj;
    await context.refreshLoraAdapters();
    context.registerExit();
    console.log(
      `llama-server ready on port ${port} (model: ${model}${mmproj ? `, mmproj: ${mmproj}` : ""})`,
    );
  }

// #666: cooldown after the Nth consecutive failed start of one model.
  function startCooldownMs(failureCount) {
    return Math.min(
      Number(context.env.LLAMA_SERVER_RETRY_COOLDOWN_MS || 300000),
      5000 * 3 ** (failureCount - 1),
    );
  }

// profile only affects which flags a *new* start gets (see PROFILE_TUNING
  // above) -- if the same model+mmproj is already running and healthy, that
  // process keeps whatever flags it started with, even if called again
  // under a different profile label. This only matters when two profiles'
  // fallback lists resolve to the same actual file (rare; today's coding
  // profile's own primary model is distinct from the others'), and forcing
  // a restart on a profile-label-only change would undo the "don't restart
  // for no reason" debounce/adoption logic below for a cosmetic difference.
  // onWait (#666) is called whenever this call is about to wait on a
  // (re)start, so a chat turn can tell the user it's waking up.
  async function ensureServerConfig(model, mmproj = null, profile = null, onWait = null, signal = null) {
    signal?.throwIfAborted();
    // After a failed start (missing binary, port conflict, out of memory),
    // don't re-pay the startup wait on every reply; let the llama-cli
    // fallback serve until the cooldown expires. #666: per model, and it
    // backs off -- 5s after the first failure, x3 per repeat, capped at
    // LLAMA_SERVER_RETRY_COOLDOWN_MS -- so a transient failure no longer
    // locks the model out for five minutes.
    const failure = context.state.startFailures.get(model);
    if (failure) {
      const retryAfterMs = failure.at + startCooldownMs(failure.count) - context.nowMs();
      if (retryAfterMs > 0) {
        const error = new Error(
          "llama-server recently failed to start; retry cooldown active",
        );
        error.retryAfterMs = retryAfterMs;
        throw error;
      }
    }

    if (context.state.starting) {
      if (onWait) onWait();
      try {
        await context.state.starting;
      } catch (e) {
        // Previous start failed; fall through and retry below.
      }
    }

    if (
      context.state.model === model &&
      (context.state.mmproj || null) === (mmproj || null) &&
      context.state.ctx === context.configuredContext() &&
      context.state.port &&
      (await isHealthy(context.state.port))
    ) {
      return;
    }

    // Live run (2026-09-29): a call that got past the checks above while
    // another one was already restarting started a second server; the one
    // that lost the state.child slot kept running untracked, so idle
    // shutdown had nothing to kill. From here to `state.starting =` is
    // synchronous, so re-checking once is enough.
    if (context.state.starting) {
      return ensureServerConfig(model, mmproj, profile, onWait, signal);
    }

    const isRunning = Boolean(context.state.child || context.state.port);
    if (
      isRunning &&
      context.state.model &&
      context.state.model !== model &&
      context.swapDebounceMs > 0 &&
      // #889: swaps to or from the gaming model are never skipped.
      ![model, context.state.model].includes(context.env.MANA_GAMING_LLAMA_MODEL) &&
      context.state.loadedAt !== null &&
      context.nowMs() - context.state.loadedAt < context.swapDebounceMs
    ) {
      console.log(
        `llama-server: swap to ${model} debounced (current model loaded ${context.nowMs() - context.state.loadedAt}ms ago, ` +
          `window ${context.swapDebounceMs}ms); serving from ${context.state.model} instead`,
      );
      return;
    }

    context.assertVramForSwap(model, mmproj);

    if (onWait) onWait();
    const swapStartedAt = context.nowMs();
    if (isRunning) {
      if (context.state.model && context.state.model !== model) {
        console.log(
          `llama-server: switching model ${context.state.model} -> ${model}`,
        );
      }
      context.stop(); // startServer() waits for the exit
    }

    signal?.throwIfAborted();
    context.state.loading = { model, since: context.nowMs() };
    context.state.starting = startServer(model, mmproj, profile, signal);
    try {
      await context.state.starting;
      context.state.startFailures.delete(model);
      context.state.loadedAt = context.nowMs();
      // #693: only a process this runtime spawned proves the new build
      // works -- an adopted server may still be the old one.
      if (context.state.child) {
        settleBuild(null);
      }
      if (isRunning) {
        context.state.lastSwapMs = context.state.loadedAt - swapStartedAt;
        context.logPerf("llama-server-swap", swapStartedAt);
        // Issue #320: visibility only -- logged, not gated on. Lets a real
        // swap's actual post-load headroom be compared against
        // assertVramForSwap's pre-load estimate above.
        const postSwapUsage = context.detectGpuVramUsage();
        const vramNote = postSwapUsage
          ? `, ${postSwapUsage.freeMb}MB VRAM free`
          : "";
        console.log(`llama-server: swap completed in ${context.state.lastSwapMs}ms${vramNote}`);
      }
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      const count = (context.state.startFailures.get(model)?.count || 0) + 1;
      context.state.startFailures.set(model, { at: context.nowMs(), count });
      e.retryAfterMs = startCooldownMs(count);
      // #693: an update-installed build that won't start is swapped back
      // to the previous one; skip the retry cooldown so the next reply
      // starts on it straight away instead of falling back to llama-cli.
      if (settleBuild(e)) {
        context.state.startFailures.clear();
        e.retryAfterMs = 0;
      }
      throw e;
    } finally {
      context.state.starting = null;
      context.state.loading = null;
    }
  }

// Returns true when the pointer was rolled back. Pointer I/O problems are
  // logged, never allowed to change how a start succeeded or failed.
  function settleBuild(startError) {
    if (!context.state.lastStartBin) return false;
    try {
      const next = context.settleActiveBuild(context.toolsDir, context.fs, context.path.win32.dirname(context.state.lastStartBin), startError);
      if (next && startError) {
        console.warn(
          `llama-server failed to start on updated build ${next.lastRollback.from}; ` +
            `rolled back to ${next.lastRollback.to}. Reason: ${next.lastRollback.reason}`,
        );
        return true;
      }
    } catch (pointerError) {
      console.warn(`llama-server: could not update tools/llama/active.json: ${pointerError.message}`);
    }
    return false;
  }

// #872: images = the turn's attached images, if any. The first image turn
  // restarts the chat server with its mmproj; later turns keep it until
  // unloadVision().
  async function ensureServer(profile, images = null, { signal = null } = {}) {
    if (images?.length) context.noteImageTurn();
    const model = context.findLlamaModel(profile);
    return ensureServerConfig(model, chatMmprojToLoad(model), profile, null, signal);
  }

function chatMmprojToLoad(model) {
    return context.state.visionWanted ? context.chatMmprojFor(model) : null;
  }

// #666: a chat turn waits out a llama-server (re)start or a brief outage
  // instead of failing. Retries back off (2s, 6s, 18s, or the cooldown if
  // longer) while they fit in LLAMA_SERVER_TURN_WAIT_MS (20s), then the
  // profile's fallbackProfile gets one try. onWait fires at most once, the
  // first time the turn actually has to wait. Resolves to the profile that
  // is ready; rejects with the primary's error when nothing came up.
  async function waitForServer(profile, onWait = null, images = null, { signal = null } = {}) {
    if (images?.length) context.noteImageTurn();
    let waited = false;
    const notify = () => {
      if (waited) return;
      waited = true;
      if (onWait) onWait();
    };
    const deadline = context.nowMs() + Number(context.env.LLAMA_SERVER_TURN_WAIT_MS || 20000);
    const model = context.findLlamaModel(profile);
    for (let delayMs = 2000; ; delayMs *= 3) {
      try {
        await ensureServerConfig(model, chatMmprojToLoad(model), profile, notify, signal);
        signal?.throwIfAborted();
        return profile;
      } catch (e) {
        signal?.throwIfAborted();
        const waitMs = Math.max(delayMs, e.retryAfterMs || 0);
        if (context.nowMs() + waitMs <= deadline) {
          notify();
          await context.sleep(waitMs, null, { signal });
          continue;
        }
        const fallback = context.backupProfileFor(profile);
        if (!fallback) throw e;
        try {
          const fallbackModel = context.findLlamaModel(fallback);
          await ensureServerConfig(fallbackModel, chatMmprojToLoad(fallbackModel), fallback, notify, signal);
        } catch {
          throw e;
        }
        return fallback;
      }
    }
  }

  return { serverPort, isHealthy, getRunningModelPath, sameModelPath, startServer, startCooldownMs, ensureServerConfig, settleBuild, ensureServer, chatMmprojToLoad, waitForServer };
}

module.exports = { createServerStartup };
