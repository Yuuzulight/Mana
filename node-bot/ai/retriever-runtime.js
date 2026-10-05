const defaultFs = require("node:fs");
const path = require("node:path");
const { createOnDemandProcess } = require("../utils/on-demand-process");
const { GAMING_IDLE_MS } = require("../utils/gaming-watch");

// #884: the Python retriever (tools/retriever_service.py, the coding-mode
// fallback after tools/retriever-index) settles around 0.5 GB since #809
// moved its chunk metadata into SQLite, so it runs on demand again: a coding
// turn that reaches it starts it (utils/on-demand-process.js, like the
// embedder and Kokoro), and it stops after MANA_RETRIEVER_IDLE_MS (default
// 10 min; 2 min while gaming, and at once when a watched game starts --
// server.js). One already answering (the launcher's MANA_START_RETRIEVER=1,
// or started by hand) is used and never stopped. Only a loopback
// RETRIEVER_URL on the script's fixed port 9000 is managed, and only when a
// built index (index.ann + metadata.sqlite) exists.
//
// Measured 14-34 s to healthy (mostly importing torch; the slow end with
// other builds running), so the bound leaves room for a busy machine.
const STARTUP_TIMEOUT_MS = 2 * 60 * 1000;

function createRetrieverRuntime(options = {}) {
  const env = options.env || process.env;
  const fs = options.fs || defaultFs;
  const rootDir = options.rootDir || path.join(__dirname, "..", "..");
  const gaming = options.gaming || (() => false);
  const script = path.join(rootDir, "tools", "retriever_service.py");
  const storeDir = env.VECTOR_STORE_DIR || path.join(rootDir, "tools", "vector_store");
  // Without these the service never turns healthy (503 until the startup
  // timeout), so it isn't started at all.
  const required = [script, path.join(storeDir, "index.ann"), path.join(storeDir, "metadata.sqlite")];
  // Same interpreter choice as the native launcher's StartRetriever.
  const venvPython = path.join(rootDir, "venv", "Scripts", "python.exe");

  let url = null;
  try {
    url = new URL(env.RETRIEVER_URL || "http://127.0.0.1:9000");
  } catch (e) {}
  const managed =
    Boolean(url) &&
    ["127.0.0.1", "localhost"].includes(url.hostname) &&
    url.port === "9000" &&
    // Never spawn from test runs -- same guard as the reranker.
    !(env.NODE_ENV === "test" || env.NODE_TEST_CONTEXT);

  const service = createOnDemandProcess({
    resourceCoordinator: options.resourceCoordinator,
    resourceEstimate: () => ({ ramMb: 1024 }),
    name: "Python retriever",
    healthUrl: () => `${url.origin}/health`,
    command: () => ({
      bin: fs.existsSync(venvPython) ? venvPython : "python",
      args: ["-u", script],
      options: { cwd: rootDir },
    }),
    idleMs: () =>
      gaming()
        ? GAMING_IDLE_MS
        : Number(env.MANA_RETRIEVER_IDLE_MS === undefined ? 600000 : env.MANA_RETRIEVER_IDLE_MS),
    startupTimeoutMs: STARTUP_TIMEOUT_MS,
    spawn: options.spawn,
    fetch: options.fetch,
    sleep: options.sleep,
  });

  // Resolves once the retriever answers, or at once when it isn't managed
  // or there's no built index; rejects when it can't be started. Callers
  // fall back either way.
  async function ensure() {
    if (!managed || !required.every((file) => fs.existsSync(file))) return;
    await service.ensure();
    service.touch();
  }

  async function use(fn) {
    if (!managed || !required.every((file) => fs.existsSync(file))) return fn();
    return service.use(fn);
  }
  return { ensure, use, stop: service.stop };
}

module.exports = { createRetrieverRuntime };
