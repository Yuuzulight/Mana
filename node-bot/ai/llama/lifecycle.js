function createLifecycle(context) {
function stop() {
    if (context.state.idleTimer) {
      clearTimeout(context.state.idleTimer);
      context.state.idleTimer = null;
    }
    const child = context.state.child;
    context.state.child = null;
    context.state.model = null;
    context.state.mmproj = null;
    context.state.port = null;
    if (child) {
      context.killProcessTree(child, { platform: context.platform, execFile: context.execFile, env: context.env });
      context.state.stopping = context.waitForExit(child, "llama-server");
    }
    return child;
  }

function scheduleIdleShutdown() {
    // Default: release the model (RAM and, with GPU offload, VRAM) after 10
    // minutes without a reply. Set LLAMA_SERVER_IDLE_MS=0 to keep it resident.
    const idleMs = Number(
      context.env.LLAMA_SERVER_IDLE_MS === undefined ? 600000 : context.env.LLAMA_SERVER_IDLE_MS,
    );
    if (!idleMs || idleMs <= 0 || Number.isNaN(idleMs)) {
      return;
    }
    if (context.state.idleTimer) {
      clearTimeout(context.state.idleTimer);
    }
    context.state.idleTimer = setTimeout(() => {
      // A timer left over from before an unexpected exit must not kill the
      // restart in progress (a failed start counts against a #693 build);
      // the reply it's for schedules a fresh one.
      if (context.state.starting) return;
      const port = context.state.port;
      // #872: and the next start is text-only until an image asks again.
      context.state.visionWanted = false;
      const child = stop();
      if (!child) {
        // Adopted (see startServer): no handle to it, so nothing to kill.
        if (port) {
          console.log(
            `llama-server idle for ${idleMs}ms, but the one on port ${port} wasn't started by this backend -- leaving it running`,
          );
        }
        return;
      }
      console.log(`llama-server idle for ${idleMs}ms, shutting it down (pid ${child.pid})`);
      context.state.stopping.then((exited) => {
        if (exited) console.log(`llama-server (pid ${child.pid}) stopped`);
      });
    }, idleMs);
    if (typeof context.state.idleTimer.unref === "function") {
      context.state.idleTimer.unref();
    }
  }

function registerExit() {
    if (!context.registerExitHandlers || context.state.exitHandlerRegistered) {
      return;
    }
    context.state.exitHandlerRegistered = true;
    process.once("exit", () => {
      stop();
    });
    // Best-effort cleanup on Ctrl+C / termination so the server child is not
    // orphaned. A hard kill of the backend still leaves the child running,
    // but the next backend start adopts it via the same-model port check.
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => {
        stop();
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
    }
  }

// #872: (re)starts the vision idle countdown. While a watched game runs
  // it's the embedder's short gaming idle, so a mid-game image doesn't
  // hold the mmproj's VRAM for 10 minutes.
  function noteImageTurn() {
    context.state.visionWanted = true;
    clearTimeout(context.state.visionTimer);
    const idleMs = context.gaming()
      ? context.GAMING_IDLE_MS
      : Number(context.env.MANA_VISION_IDLE_MS === undefined ? 600000 : context.env.MANA_VISION_IDLE_MS);
    if (!(idleMs > 0)) return; // 0: kept until the server's own idle shutdown
    context.state.visionTimer = setTimeout(unloadVision, idleMs);
    context.state.visionTimer.unref?.();
  }

// #872: restarts the chat server without its mmproj (idle, or a watched
  // game started). Mid-reply it waits: the last reply to finish calls it
  // again (see inTurn).
  function unloadVision() {
    if (context.state.busy > 0) {
      context.state.visionUnloadPending = true;
      return;
    }
    context.state.visionUnloadPending = false;
    clearTimeout(context.state.visionTimer);
    context.state.visionWanted = false;
    if (!context.state.mmproj || context.state.starting) return;
    // Only a chat model's server: a separate vision model (describe-first)
    // is swapped out by the next chat turn anyway.
    const profile = context.getKnownLlamaModelProfiles().find(isProfileAlreadyLoaded);
    if (!profile) return;
    console.log("Vision idle: restarting llama-server without the mmproj");
    context.ensureServerConfig(context.state.model, null, profile).then(
      // stop() cleared the idle shutdown; the restarted server needs one.
      scheduleIdleShutdown,
      (e) => console.warn("llama-server restart without the mmproj failed:", e.message),
    );
  }

// #889: a watched game started (true) or ended (false). With
  // MANA_GAMING_LLAMA_MODEL set, the chat server swaps to that model (see
  // buildServerArgs for its context and KV cache) so Fish can stay on the
  // GPU next to the game, and back when it ends. Without it, a game start
  // only drops the vision mmproj (#872). Like unloadVision, a swap that
  // lands mid-reply waits for the last reply to finish (see inTurn).
  function setGaming(on) {
    const gamingModel = context.env.MANA_GAMING_LLAMA_MODEL;
    if (!gamingModel || (on && !context.fs.existsSync(gamingModel))) {
      if (gamingModel) console.warn(`MANA_GAMING_LLAMA_MODEL not found, keeping the normal model: ${gamingModel}`);
      if (on) unloadVision();
      return;
    }
    if (context.state.busy > 0) {
      context.state.gamingSwapPending = on;
      // The swap drops the mmproj anyway; one restart, not two.
      if (on) context.state.visionUnloadPending = false;
      return;
    }
    context.state.gamingSwapPending = null;
    if (context.state.gamingModel === on) return;
    context.state.gamingModel = on;
    clearTimeout(context.state.visionTimer);
    context.state.visionWanted = false;
    // Nothing loaded: the next turn starts the right model.
    if (!context.state.port && !context.state.starting) return;
    console.log(`Watched game ${on ? "started" : "ended"}: restarting llama-server with the ${on ? "gaming" : "normal"} model`);
    context.ensureServerConfig(context.findLlamaModel(), null, "default").then(
      scheduleIdleShutdown,
      (e) => console.warn("llama-server gaming model swap failed:", e.message),
    );
  }

// #872: counts a reply as in flight, so unloadVision (and #889's
  // setGaming) never restarts the server under it.
  function inTurn(fn) {
    return async (...args) => {
      context.state.busy += 1;
      const signal = args.find(value => value?.signal)?.signal || args.find(value => value?.extraMessages?.signal)?.extraMessages.signal;
      const cancelOwned = () => { if (context.state.busy === 1 && context.state.child) stop(); };
      signal?.addEventListener('abort', cancelOwned, { once: true });
      try {
        signal?.throwIfAborted();
        return await fn(...args);
      } finally {
        signal?.removeEventListener('abort', cancelOwned);
        context.state.busy -= 1;
        let cleanupError;
        if (signal?.aborted && context.state.busy === 0) {
          if (context.state.child) stop();
          if (context.state.stopping && !(await context.state.stopping)) {
            cleanupError = new Error('Cancelled local model process did not exit');
            cleanupError.code = 'LOCAL_CLEANUP_FAILED';
          }
        }
        if (!signal?.aborted && context.state.busy === 0 && context.state.gamingSwapPending !== null) setGaming(context.state.gamingSwapPending);
        if (!signal?.aborted && context.state.busy === 0 && context.state.visionUnloadPending) unloadVision();
        // #1214: her context ended while chat replies were in flight.
        if (context.state.busy === 0 && context.state.contextRestorePending) {
          context.state.contextOverride = null;
          context.state.contextRestorePending = false;
        }
        if (cleanupError) throw cleanupError;
      }
    };
  }

// Foundational tool-calling loop (issue #51). Single round only: the
  // model gets one chance to call tools, sees the results, and produces a
  // final reply -- deliberately not a multi-step agent loop yet. Every tool
  // call is executed through the caller-supplied toolPolicy (see
  // ai/tool-policy.js), never dispatched by name without going through it,
  // so the actual read/write/exec boundary lives in one place.
  //
  // Real-hardware finding behind this: Qwen3-4B (the "default" profile)
  // reliably emits proper OpenAI-format tool_calls via llama-server's
  // --jinja chat template (3/3 in testing). qwen2.5-coder-7b (the "coding"
  // profile) does not -- it wraps the same well-formed JSON in a markdown
  // code fence inside `content` instead of the <tool_call> XML tags its own
  // template asks for, so llama-server's parser never recognizes it as a
  // tool call. Tool-calling here is scoped to profiles that pass this check
  // (currently: default), not assumed to work everywhere.
  // Issue #183: bounded multi-round loop, not a fixed two-call sequence --
  // the model can call tools, see results, and call more tools across
  // several rounds (needed for #169's outbound MCP client tools to be
  // useful at all; a single-round loop can't let a remote tool's results
  // inform a second tool call). Every cap below exists because an LLM tool
  // loop is exactly the kind of thing that can run away: too many rounds,
  // too many calls in one round, too long wall-clock, or stuck repeatedly
  // calling the same broken tool. Whenever a cap is hit, one final
  // tools-disabled completion call forces the model to synthesize an
  // answer from whatever it already knows, rather than returning a blank
  // or synthetic fallback string.
  //
  // Issue #676: goal mode (options.goal set). A reply without tool calls no
  // longer ends the loop: the model is re-asked against the goal until it
  // calls session_goal__finish, stalls (two re-checks in a row answered
  // with neither a tool nor finish), leaves a call waiting on approval, or
  // hits a cap -- the round and time caps are longer here
  // (MANA_GOAL_MODE_MAX_ROUNDS / _MAX_MS), and the loop also stops before
  // the prompt outgrows 80% of the context. Then one
  // review call checks the draft against the request; anything missing
  // goes back in as the next re-check (at most 2 cycles, budget allowing),
  // else the answer opens with "Not done yet: ...".
  // #1214: a reply with its own contextSize (her self-work runs) gets a
  // server with that context while it runs; chat keeps LLAMA_CONTEXT, so
  // the next reply without one restarts the server back to it. The switch
  // waits (bounded) until no other reply is in flight, so it never restarts
  // the server under a chat turn, and needs VRAM for the larger KV cache;
  // otherwise this reply runs at the default context. Chat turns that start
  // meanwhile run on her context; the default comes back once the last
  // reply in flight ends (inTurn).
  function withContextSize(fn) {
    return async (prompt, toolPolicy, options = {}) => {
      const ctx = Number(options?.contextSize) || 0;
      if (ctx <= context.configuredContext()) return fn(prompt, toolPolicy, options);
      for (let waited = 0; context.state.busy > 0 && waited < context.CONTEXT_SWITCH_WAIT_MS; waited += 1000) await context.sleep(1000);
      if (context.state.busy > 0 || !context.contextFits(ctx)) {
        console.warn(`llama-server: staying at ${context.configuredContext()} context, not ${ctx} (${context.state.busy > 0 ? "a reply is still in flight" : "not enough VRAM for its KV cache"})`);
        return fn(prompt, toolPolicy, options);
      }
      context.state.contextOverride = ctx;
      context.state.contextRestorePending = false;
      try {
        return await fn(prompt, toolPolicy, options);
      } finally {
        if (context.state.busy === 0) context.state.contextOverride = null;
        else context.state.contextRestorePending = true;
      }
    };
  }

function getStatus() {
    return {
      enabled: context.isEnabled(),
      running: Boolean(context.state.port && context.state.model),
      external: Boolean(context.state.port && context.state.model && !context.state.child),
      model: context.state.model,
      mmproj: context.state.mmproj,
      // #889: the running model is the gaming model.
      gamingModel: Boolean(context.state.gamingModel && context.state.model === context.env.MANA_GAMING_LLAMA_MODEL),
      port: context.state.port,
      lastSwapMs: context.state.lastSwapMs,
      loading: context.state.loading,
    };
  }

// Issue #431: lets a caller (memory-tool-source.js's LLM-confirmed
  // conflict judge) find out whether calling runLocalAssistantReply(...,
  // profile) would be truly free -- reuses the exact same resolution
  // ensureServerConfig itself uses, not just a name-membership guess, since
  // a profile's preferred file can differ from whatever happens to be
  // running right now even when the running model's name also appears
  // somewhere in that profile's list (a higher-preference file for that
  // profile might also exist on disk). A caller that skips this check and
  // guesses wrong risks a real model swap -- exactly the failure mode that
  // crashed system RAM earlier in this session's own #360 testing.
  function isProfileAlreadyLoaded(profile) {
    return Boolean(context.state.port && context.state.model && context.findLlamaModel(profile) === context.state.model);
  }

  return { stop, scheduleIdleShutdown, registerExit, noteImageTurn, unloadVision, setGaming, inTurn, withContextSize, getStatus, isProfileAlreadyLoaded };
}

module.exports = { createLifecycle };
