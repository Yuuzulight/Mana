const defaultFs = require("node:fs");
const path = require("node:path");
const { spawn: defaultSpawn } = require("node:child_process");

// Issue #674: an optional CPU-only reranker for memory recall -- a second,
// small llama-server started on demand with --reranking on its own port,
// shut down after an idle period like the main one. Off unless
// MANA_RERANKER_MODEL names an existing local .gguf file (recommended:
// bge-reranker-v2-m3, see node-bot/.env.sample); nothing is ever
// downloaded -- only `-m <local file>` is passed, never `-hf`.
//
// rerank() never throws and never waits longer than its timeout: on any
// failure it returns the input order, so callers keep their own ordering.
// The first call after a cold start usually times out while the model
// loads; the server keeps starting in the background and later calls use it.
const STARTUP_TIMEOUT_MS = 60 * 1000;
// Same cooldown the main runtime uses after a failed start, so a broken
// setup doesn't respawn a process on every turn.
const RETRY_COOLDOWN_MS = 5 * 60 * 1000;
// Pairs have to fit one physical batch (llama-server's -ub, 512 tokens by
// default) -- a query plus a document cut to these stays well under it.
const MAX_QUERY_CHARS = 500;
const MAX_DOC_CHARS = 500;
// Only the first N docs (callers pass them best-first) are scored; the rest
// keep their place after them. Measured on the RTX 5080 box's CPU: ~0.53 s
// warm for 10 docs vs ~1.1 s for 20, and this sits in front of a voice reply.
const DEFAULT_MAX_DOCS = 10;

function createReranker(options = {}) {
  const env = options.env || process.env;
  const fs = options.fs || defaultFs;
  const spawn = options.spawn || defaultSpawn;
  const fetchImpl = options.fetch || globalThis.fetch;
  // Reuses llama-server-runtime's binary resolution (#693 active.json
  // pointer first, then LLAMA_SERVER_BIN/LLAMA_BIN/bundled build).
  const findServerBin = options.findServerBin;
  const threads = Number(options.threads || env.LLAMA_THREADS || 4);
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const state = { child: null, ready: false, starting: null, idleTimer: null, failedAt: 0 };
  let exitHandlerRegistered = false;

  function port() {
    return Number(env.MANA_RERANKER_PORT || 8091);
  }

  // Absolute path to an existing .gguf file, or null (reranker off).
  function modelPath() {
    const model = String(env.MANA_RERANKER_MODEL || "").trim();
    if (!model || !path.isAbsolute(model) || !/\.gguf$/i.test(model)) return null;
    try {
      return fs.statSync(model).isFile() ? model : null;
    } catch (e) {
      return null;
    }
  }

  function isEnabled() {
    // Never spawn from test runs -- same guard as llama-server-runtime.
    if (env.NODE_ENV === "test" || env.NODE_TEST_CONTEXT) return false;
    return Boolean(findServerBin && modelPath());
  }

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

  function scheduleIdleShutdown() {
    const idleMs = Number(env.MANA_RERANKER_IDLE_MS === undefined ? 600000 : env.MANA_RERANKER_IDLE_MS);
    if (!idleMs || idleMs <= 0 || Number.isNaN(idleMs)) return;
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      console.log(`Reranker idle for ${idleMs}ms, shutting it down`);
      stop();
    }, idleMs);
    state.idleTimer.unref?.();
  }

  async function isHealthy() {
    try {
      const resp = await fetchImpl(`http://127.0.0.1:${port()}/health`);
      return Boolean(resp && resp.ok);
    } catch (e) {
      return false;
    }
  }

  async function startServer() {
    // A reranker left over from a hard-killed backend still holds the
    // port -- use it rather than failing to bind.
    if (await isHealthy()) {
      state.ready = true;
      return;
    }
    const bin = findServerBin();
    const args = [
      "-m", modelPath(),
      "--host", "127.0.0.1",
      "--port", String(port()),
      "--reranking",
      "-ngl", "0",
      "-t", String(threads),
      "--no-webui",
    ];
    console.log("Starting reranker llama-server:", bin, args.join(" "));
    const child = spawn(bin, args, {
      cwd: path.win32.dirname(bin),
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      // -ngl 0 keeps the weights on the CPU; hiding the GPU as well stops
      // the CUDA build from offloading large matmuls or allocating a CUDA
      // context, so the reranker never touches VRAM.
      env: { ...env, CUDA_VISIBLE_DEVICES: "-1" },
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
        console.warn(`Reranker llama-server exited (code ${code})`);
      }
    });
    state.child = child;
    if (!exitHandlerRegistered) {
      exitHandlerRegistered = true;
      process.once("exit", stop);
    }

    const startedAt = Date.now();
    while (!(await isHealthy())) {
      if (exited || Date.now() - startedAt > STARTUP_TIMEOUT_MS) {
        stop();
        throw new Error(`reranker did not start: ${stderrTail.slice(-500) || "timed out"}`);
      }
      await sleep(500);
    }
    state.ready = true;
    scheduleIdleShutdown();
    console.log(`Reranker ready on port ${port()}`);
  }

  function ensureServer() {
    if (state.ready) return Promise.resolve();
    if (Date.now() - state.failedAt < RETRY_COOLDOWN_MS) {
      return Promise.reject(new Error("reranker failed to start recently, retrying later"));
    }
    if (!state.starting) {
      state.starting = startServer()
        .catch((e) => {
          state.failedAt = Date.now();
          throw e;
        })
        .finally(() => {
          state.starting = null;
        });
    }
    return state.starting;
  }

  function deadline(ms) {
    let timer;
    const promise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    });
    return { promise, cancel: () => clearTimeout(timer) };
  }

  // Returns { order, reranked, ms, fallback }: `order` is a permutation of
  // docs' indices, best first -- the input order unless reranked is true.
  async function rerank(query, docs, { timeoutMs } = {}) {
    const inputOrder = docs.map((_, i) => i);
    if (docs.length < 2 || !isEnabled()) {
      return { order: inputOrder, reranked: false, ms: 0, fallback: null };
    }
    const budgetMs = Number(timeoutMs || env.MANA_RERANKER_TIMEOUT_MS) || 1500;
    const sent = docs.slice(0, Number(env.MANA_RERANKER_MAX_CANDIDATES) || DEFAULT_MAX_DOCS);
    const startedAt = Date.now();
    const limit = deadline(budgetMs);
    const controller = new AbortController();
    try {
      await Promise.race([ensureServer(), limit.promise]);
      scheduleIdleShutdown();
      const resp = await Promise.race([
        fetchImpl(`http://127.0.0.1:${port()}/v1/rerank`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: String(query || "").slice(0, MAX_QUERY_CHARS),
            documents: sent.map((doc) => String(doc || "").slice(0, MAX_DOC_CHARS)),
          }),
          signal: controller.signal,
        }),
        limit.promise,
      ]);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = await Promise.race([resp.json(), limit.promise]);
      const ranked = (Array.isArray(body?.results) ? body.results : [])
        .filter((r) => Number.isInteger(r?.index) && r.index >= 0 && r.index < sent.length)
        .sort((a, b) => Number(b.relevance_score) - Number(a.relevance_score))
        .map((r) => r.index);
      if (!ranked.length) throw new Error("no results in rerank response");
      // Any index not scored (past the cap, or left out by the server) keeps
      // its place after the ranked ones.
      return {
        order: [...new Set([...ranked, ...inputOrder])],
        reranked: true,
        ms: Date.now() - startedAt,
        fallback: null,
      };
    } catch (e) {
      controller.abort();
      // An adopted server has no child to watch for exit -- re-check it
      // next time instead of assuming it is still there.
      if (!state.child) state.ready = false;
      const fallback = e?.message || String(e);
      console.warn("Reranker unavailable, keeping input order:", fallback);
      return { order: inputOrder, reranked: false, ms: Date.now() - startedAt, fallback };
    } finally {
      limit.cancel();
    }
  }

  return { rerank, isEnabled, stop };
}

module.exports = { createReranker };
