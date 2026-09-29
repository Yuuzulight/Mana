const defaultFs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn: defaultSpawn } = require("node:child_process");
const { createOnDemandProcess } = require("../utils/on-demand-process");

// #619: whisper.cpp's whisper-server, kept loaded between requests
// (utils/on-demand-process.js, like the reranker) so a transcription
// doesn't pay whisper-cli's process start and model load every time --
// live partials have to land before the end-of-turn silence runs out.
// Installed next to whisper-cli (WHISPER_BIN's directory). transcribe()
// returns null whenever the server can't be used, and the caller then
// runs whisper-cli as before.
const REQUEST_TIMEOUT_MS = 30 * 1000;
const IDLE_MS = 60 * 60 * 1000;

function createWhisperServer(options = {}) {
  const env = options.env || process.env;
  const fs = options.fs || defaultFs;
  const fetchImpl = options.fetch || globalThis.fetch;
  // whisper-discovery's lookups: whisper-cli's path and the model's.
  const findCliBin = options.findCliBin;
  const findModel = options.findModel;
  // The whisper-cli settings from server.js, so both give the same text.
  // threads() is read at each start: fewer while a game is running.
  const { threads, language, beamSize, noSpeechThreshold } = options;
  const spawnImpl = options.spawn || defaultSpawn;
  let startedThreads = null;

  const server = createOnDemandProcess({
    name: "whisper-server",
    healthUrl: () => `${baseUrl()}/health`,
    command: () => {
      const bin = serverBin();
      startedThreads = threads();
      return {
        bin,
        args: [
          "-m", findModel(),
          "--host", "127.0.0.1",
          "--port", String(port()),
          "-t", String(startedThreads),
          "-l", String(language),
          "-bs", String(beamSize),
          // whisper-cli's default; whisper-server's is 2.
          "-bo", "5",
          "-nth", String(noSpeechThreshold),
          "--carry-initial-prompt",
        ],
        options: { cwd: path.dirname(bin) },
      };
    },
    idleMs: () => IDLE_MS,
    spawn: (bin, args, spawnOptions) => belowNormal(spawnImpl(bin, args, spawnOptions)),
    fetch: fetchImpl,
    sleep: options.sleep,
  });

  // A request in flight, and the model reload that follows each one.
  let busy = false;
  let reset = Promise.resolve();

  function port() {
    return Number(env.WHISPER_SERVER_PORT || 8093);
  }

  function baseUrl() {
    return `http://127.0.0.1:${port()}`;
  }

  function serverBin() {
    const cli = findCliBin();
    return env.WHISPER_SERVER_BIN || (cli && path.join(path.dirname(cli), `whisper-server${path.extname(cli)}`));
  }

  function isEnabled() {
    // Never spawn from test runs -- same guard as the reranker/embedder.
    if (env.NODE_ENV === "test" || env.NODE_TEST_CONTEXT) return false;
    const bin = serverBin();
    return Boolean(bin && findModel() && fs.existsSync(bin));
  }

  // The transcript, or null (not installed, failed to start, request
  // failed, or another request is in flight -- whisper-server runs one at
  // a time, and whisper-cli runs alongside it like it always has).
  async function transcribe(filePath, { prompt, temperature }) {
    if (busy || !isEnabled()) return null;
    busy = true;
    try {
      // A game started or stopped since this server was launched:
      // restart it with the right thread count (~0.25 s).
      if (startedThreads !== null && startedThreads !== threads()) server.stop();
      await server.ensure();
      await reset;
      server.touch();
      const form = new FormData();
      form.append("file", new Blob([await fs.promises.readFile(filePath)]), path.basename(filePath));
      form.append("response_format", "json");
      form.append("prompt", String(prompt));
      form.append("temperature", String(temperature));
      const resp = await fetchImpl(`${baseUrl()}/inference`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = await resp.json();
      if (!resp.ok || typeof body?.text !== "string") throw new Error(body?.error || `HTTP ${resp.status}`);
      // whisper-server keeps decoder state between requests: measured, the
      // same clip transcribed twice came back different the second time
      // ("(singing in foreign language)"). Reloading the model (~200 ms,
      // after this transcript is on its way) makes every request match a
      // fresh whisper-cli run; the next request waits for it.
      const load = new FormData();
      load.append("model", findModel());
      reset = fetchImpl(`${baseUrl()}/load`, {
        method: "POST",
        body: load,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).catch(() => {});
      // One line per segment; a segment can end mid-word ("Genki\nami").
      return body.text.replace(/\n/g, "").trim();
    } catch (e) {
      // Restarted fresh on next use rather than trusted: it may be wedged,
      // or still working on a request that timed out.
      server.stop();
      console.warn("whisper-server unavailable, using whisper-cli:", e?.message || e);
      return null;
    } finally {
      busy = false;
    }
  }

  return { transcribe };
}

// Lets a game (and Discord) have the CPU first: whisper only slows down
// while they actually need the cores.
function belowNormal(child) {
  try {
    if (child?.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch (e) {}
  return child;
}

module.exports = { createWhisperServer, belowNormal };
