const defaultFs = require("node:fs");
const path = require("node:path");
const { spawn: defaultSpawn } = require("node:child_process");
const { createOnDemandProcess } = require("../utils/on-demand-process");

// Text embeddings for semantic memory search on the GPU: a small
// llama-server with --embedding, started on first use and stopped after an
// idle period (utils/on-demand-process.js, like the reranker), in place of
// the always-on Python sentence-transformers service (tools/local_embedder.py,
// ~0.5-1 GB of system RAM). Off unless MANA_EMBEDDER_MODEL names an existing
// local .gguf file (Qwen3-Embedding-0.6B-Q8_0, see node-bot/.env.sample);
// nothing is ever downloaded.
//
// Texts go in as-is, same as local_embedder.py (which encodes queries and
// documents alike, with no instruction prompt). The Qwen3-Embedding GGUF's
// metadata already asks for last-token pooling and an appended EOS token,
// the same as the sentence-transformers model; --pooling last just pins it.
const STARTUP_TIMEOUT_MS = 60 * 1000;
// Each input has to fit one physical batch (-ub), or the whole request
// fails; cutting inputs to this many characters keeps them under this many
// tokens. Measured on the RTX 5080: ~2.3 GB VRAM at 2048 (1.4 GB at 512,
// 6.6 GB at 8192); memory texts (facts, messages, turns) are far shorter.
const MAX_TOKENS = 2048;

function createEmbedder(options = {}) {
  const env = options.env || process.env;
  const fs = options.fs || defaultFs;
  const spawn = options.spawn || defaultSpawn;
  const fetchImpl = options.fetch || globalThis.fetch;
  // From llama-server-runtime: the #693 active build, and whether it knows
  // --load-mode (#747).
  const findServerBin = options.findServerBin;
  const supportsLoadMode = options.supportsLoadMode || (() => true);
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const server = createOnDemandProcess({
    name: "Embedding llama-server",
    healthUrl: () => `http://127.0.0.1:${port()}/health`,
    command: () => {
      const bin = findServerBin();
      return {
        bin,
        args: [
          "-m", modelPath(),
          "--host", "127.0.0.1",
          "--port", String(port()),
          "--embedding",
          "--pooling", "last",
          "-ngl", "99",
          "-c", String(MAX_TOKENS),
          "-b", String(MAX_TOKENS),
          "-ub", String(MAX_TOKENS),
          "--no-webui",
          // Weights straight into VRAM instead of mapping the file into
          // system RAM (#747).
          ...(supportsLoadMode(bin) ? ["--load-mode", "none"] : ["--no-mmap"]),
        ],
        options: { cwd: path.win32.dirname(bin) },
      };
    },
    idleMs: () => Number(env.MANA_EMBEDDER_IDLE_MS === undefined ? 600000 : env.MANA_EMBEDDER_IDLE_MS),
    startupTimeoutMs: STARTUP_TIMEOUT_MS,
    spawn,
    fetch: fetchImpl,
    sleep,
  });

  function port() {
    return Number(env.MANA_EMBEDDER_PORT || 8092);
  }

  // Absolute path to an existing .gguf file, or null (off).
  function modelPath() {
    const model = String(env.MANA_EMBEDDER_MODEL || "").trim();
    if (!model || !path.isAbsolute(model) || !/\.gguf$/i.test(model)) return null;
    try {
      return fs.statSync(model).isFile() ? model : null;
    } catch (e) {
      return null;
    }
  }

  function isEnabled() {
    // Never spawn from test runs -- same guard as the reranker.
    if (env.NODE_ENV === "test" || env.NODE_TEST_CONTEXT) return false;
    return Boolean(findServerBin && modelPath());
  }

  // Names the vectors embed() returns, so cached vectors from another
  // model are re-embedded instead of compared against these. "" when off.
  function modelId() {
    return isEnabled() ? `llama:${path.basename(modelPath())}` : "";
  }

  // Vectors in input order; null for any input without one. Never throws.
  async function embed(inputs) {
    const out = inputs.map(() => null);
    if (!out.length) return out;
    try {
      await server.ensure();
      server.touch();
      const resp = await fetchImpl(`http://127.0.0.1:${port()}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: inputs.map((t) => String(t || "").slice(0, MAX_TOKENS)) }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = await resp.json();
      for (const d of Array.isArray(body?.data) ? body.data : []) {
        if (Number.isInteger(d?.index) && d.index >= 0 && d.index < out.length && Array.isArray(d.embedding)) {
          out[d.index] = d.embedding;
        }
      }
    } catch (e) {
      console.warn("Embedding llama-server unavailable:", e?.message || e);
    }
    return out;
  }

  return { embed, isEnabled, modelId, stop: server.stop };
}

module.exports = { createEmbedder };
