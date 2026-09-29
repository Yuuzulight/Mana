const defaultFs = require("node:fs");
const path = require("node:path");
const { createOnDemandProcess } = require("../utils/on-demand-process");
const { GAMING_IDLE_MS } = require("../utils/gaming-watch");

// User decision (#778 / #691): the Python retriever (tools/retriever_service.py,
// the coding-mode fallback after tools/retriever-index) json.loads the whole
// tools/vector_store metadata -- GBs of RAM on a real index -- so it no
// longer runs all the time. A coding turn that reaches it starts it
// (utils/on-demand-process.js, like the embedder and Kokoro), and it stops
// after MANA_RETRIEVER_IDLE_MS (default 10 min; 2 min while gaming). One
// already answering (the launcher's MANA_START_RETRIEVER=1, or started by
// hand) is used and never stopped. Only a loopback RETRIEVER_URL on the
// script's fixed port 9000 is managed.
//
// ponytail: startup timeout is a guess -- loading a multi-GB index hasn't
// been timed; raise it if a real index takes longer.
const STARTUP_TIMEOUT_MS = 3 * 60 * 1000;

function createRetrieverRuntime(options = {}) {
  const env = options.env || process.env;
  const fs = options.fs || defaultFs;
  const rootDir = options.rootDir || path.join(__dirname, "..", "..");
  const gaming = options.gaming || (() => false);
  const script = path.join(rootDir, "tools", "retriever_service.py");
  // Without a built index the service never turns healthy (503 until the
  // startup timeout), so don't start it at all.
  const index = path.join(env.VECTOR_STORE_DIR || path.join(rootDir, "tools", "vector_store"), "index.ann");
  // Same interpreter choice as windows-launcher's startRetrieverService.
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
    name: "Python retriever",
    healthUrl: () => `${url.origin}/health`,
    command: () => {
      for (const file of [script, index]) {
        if (!fs.existsSync(file)) throw new Error(`${file} not found`);
      }
      return {
        bin: fs.existsSync(venvPython) ? venvPython : "python",
        args: ["-u", script],
        options: { cwd: rootDir },
      };
    },
    idleMs: () =>
      gaming()
        ? GAMING_IDLE_MS
        : Number(env.MANA_RETRIEVER_IDLE_MS === undefined ? 600000 : env.MANA_RETRIEVER_IDLE_MS),
    startupTimeoutMs: STARTUP_TIMEOUT_MS,
    spawn: options.spawn,
    fetch: options.fetch,
    sleep: options.sleep,
  });

  // Resolves once the retriever answers (or at once when not managed);
  // rejects when it can't be started -- callers fall back as before.
  async function ensure() {
    if (!managed) return;
    await service.ensure();
    service.touch();
  }

  return { ensure, stop: service.stop };
}

module.exports = { createRetrieverRuntime };
