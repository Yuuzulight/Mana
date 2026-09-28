const defaultFs = require("node:fs");
const path = require("node:path");
const { createOnDemandProcess } = require("./utils/on-demand-process");

// User decision (no dedicated issue; native launcher side is #694 parity):
// Kokoro no longer runs all the time. It is started the first time a reply
// needs it -- TTS_PROVIDER=kokoro, the gaming override in server.js, or
// FISH_TTS_FALLBACK_PROVIDER=kokoro -- and stopped after MANA_KOKORO_IDLE_MS
// (default 10 min) without use. A Kokoro already answering KOKORO_TTS_URL
// (the Electron launcher's, or one started by hand) is used and never
// stopped. Only a loopback KOKORO_TTS_URL is managed; a remote one is left
// to whoever runs it.
//
// ensure() never throws synchronously and never crashes the backend: a
// missing tts-service venv logs one setup warning and rejects, so that
// synthesis fails the normal way.
const STARTUP_TIMEOUT_MS = 30 * 1000; // first start loads the ONNX model

function createKokoroRuntime(options = {}) {
  const env = options.env || process.env;
  const fs = options.fs || defaultFs;
  const rootDir = options.rootDir || path.join(__dirname, "..");
  const serviceDir = path.join(rootDir, "tts-service");
  // Same order as desktop-client/python-env.js: an installer's bundled
  // portable Python first, then the tts-service venv.
  const pythonCandidates = [
    path.join(rootDir, "portable-python", "tts-service", "python.exe"),
    path.join(serviceDir, "venv", "Scripts", "python.exe"),
  ];

  let url = null;
  try {
    url = new URL(env.KOKORO_TTS_URL || "http://127.0.0.1:5011");
  } catch (e) {}
  const managed =
    Boolean(url) &&
    ["127.0.0.1", "localhost"].includes(url.hostname) &&
    // Never spawn from test runs -- same guard as the reranker.
    !(env.NODE_ENV === "test" || env.NODE_TEST_CONTEXT);

  let warnedMissing = false;
  const service = createOnDemandProcess({
    name: "Kokoro TTS",
    healthUrl: () => `${url.origin}/health`,
    command: () => {
      const python = pythonCandidates.find((file) => fs.existsSync(file));
      if (!python) {
        const message =
          `Kokoro TTS is not set up (${pythonCandidates[1]} not found). Set it up once: ` +
          "python -m venv tts-service/venv, then run tts-service/start_kokoro.ps1 (see tts-service/README.md).";
        if (!warnedMissing) {
          warnedMissing = true;
          console.warn(message);
        }
        throw new Error(message);
      }
      return {
        bin: python,
        args: ["-m", "uvicorn", "kokoro_service:app", "--host", "127.0.0.1", "--port", url.port || "80"],
        options: { cwd: serviceDir },
      };
    },
    idleMs: () => Number(env.MANA_KOKORO_IDLE_MS === undefined ? 600000 : env.MANA_KOKORO_IDLE_MS),
    startupTimeoutMs: STARTUP_TIMEOUT_MS,
    spawn: options.spawn,
    fetch: options.fetch,
    sleep: options.sleep,
  });

  async function ensure() {
    if (!managed) return;
    await service.ensure();
    service.touch();
  }

  return { ensure, stop: service.stop };
}

module.exports = { createKokoroRuntime };
