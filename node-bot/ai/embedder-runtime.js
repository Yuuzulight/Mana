const defaultFs = require("node:fs");
const path = require("node:path");
const { spawn: defaultSpawn } = require("node:child_process");
const { createOnDemandProcess } = require("../utils/on-demand-process");
const { GAMING_IDLE_MS } = require("../utils/gaming-watch");

// Text embeddings for semantic memory search on the GPU: a small
// llama-server with --embedding, started on first use and stopped after an
// idle period (utils/on-demand-process.js, like the reranker), in place of
// the always-on Python sentence-transformers service (tools/local_embedder.py,
// ~0.5-1 GB of system RAM). Off unless MANA_EMBEDDER_MODEL names an existing
// local .gguf file (Qwen3-Embedding-0.6B-Q8_0, see node-bot/.env.sample);
// nothing is ever downloaded.
//
// The Qwen3-Embedding GGUF's metadata already asks for last-token pooling
// and an appended EOS token, the same as the sentence-transformers model;
// --pooling last just pins it.
const STARTUP_TIMEOUT_MS = 60 * 1000;
// Each input has to fit one physical batch (-ub), or the whole request
// fails; cutting inputs to this many characters keeps them under this many
// tokens. Measured on the RTX 5080: ~2.3 GB VRAM at 2048 (1.4 GB at 512,
// 6.6 GB at 8192).
const MAX_TOKENS = 2048;
// A longer document is embedded as overlapping MAX_TOKENS-character chunks
// in the same request, averaged into one vector, instead of raising -ub.
const CHUNK_OVERLAP = 256;
// Qwen3-Embedding is instruction-aware: a query embeds with a one-line task
// in the model card's format ("Instruct: {task}\nQuery:{query}"), documents
// go in bare -- so cached document vectors stay valid. Measured with the
// Q8_0 GGUF: "what graphics card do I have?" vs "the user's GPU is an RTX
// 5080" / "likes green tea" is 0.691 / 0.501 bare (the unrelated fact
// clears recall's 0.5 cutoff), 0.650 / 0.369 with this instruction.
const QUERY_PROMPT =
  "Instruct: Given a user's message, retrieve stored facts, notes and past conversation passages relevant to it\nQuery:";

// Code points, so a cut never splits a surrogate pair into invalid JSON.
function chunks(text) {
  const chars = Array.from(text);
  const out = [];
  for (let at = 0; ; at += MAX_TOKENS - CHUNK_OVERLAP) {
    out.push(chars.slice(at, at + MAX_TOKENS).join(""));
    if (at + MAX_TOKENS >= chars.length) return out;
  }
}

// Mean of the L2-normalized vectors, re-normalized.
function unitMean(vectors) {
  const sum = new Array(vectors[0].length).fill(0);
  for (const v of vectors) {
    const n = Math.hypot(...v) || 1;
    v.forEach((x, k) => {
      sum[k] += x / n;
    });
  }
  const n = Math.hypot(...sum) || 1;
  return sum.map((x) => x / n);
}

function createEmbedder(options = {}) {
  const env = options.env || process.env;
  const fs = options.fs || defaultFs;
  const spawn = options.spawn || defaultSpawn;
  const fetchImpl = options.fetch || globalThis.fetch;
  const threads = Number(options.threads || env.LLAMA_THREADS || 4);
  // From llama-server-runtime: the #693 active build, and whether it knows
  // --load-mode (#747).
  const findServerBin = options.findServerBin;
  const supportsLoadMode = options.supportsLoadMode || (() => true);
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  // server.js's cached watched-game status (utils/gaming-watch.js).
  const gaming = options.gaming || (() => false);

  const server = createOnDemandProcess({
    resourceCoordinator: options.resourceCoordinator,
    resourceEstimate: () => ({ ramMb: Math.ceil(fs.statSync(modelPath()).size / 1048576), vramMb: Math.max(2300, Math.ceil(fs.statSync(modelPath()).size / 1048576 * 1.2)) }),
    cpuAlternative: () => ({ ramMb: Math.ceil(fs.statSync(modelPath()).size / 1048576) + 512 }),
    name: "Embedding llama-server",
    healthUrl: () => `http://127.0.0.1:${port()}/health`,
    command: (mode) => {
      const bin = findServerBin();
      return {
        bin,
        args: [
          "-m", modelPath(),
          "--host", "127.0.0.1",
          "--port", String(port()),
          "--embedding",
          "--pooling", "last",
          "-t", String(threads),
          "-ngl", mode === 'cpu' ? '0' : '99',
          ...(mode === 'cpu' ? ['--no-kv-offload'] : []),
          "-c", String(MAX_TOKENS),
          "-b", String(MAX_TOKENS),
          "-ub", String(MAX_TOKENS),
          "--no-webui",
          // Weights straight into VRAM instead of mapping the file into
          // system RAM (#747).
          ...(supportsLoadMode(bin) ? ["--load-mode", "none"] : ["--no-mmap"]),
        ],
        options: { cwd: path.win32.dirname(bin), ...(mode === 'cpu' ? { env: { ...env, CUDA_VISIBLE_DEVICES: '-1' } } : {}) },
      };
    },
    idleMs: () =>
      gaming()
        ? GAMING_IDLE_MS
        : Number(env.MANA_EMBEDDER_IDLE_MS === undefined ? 3600000 : env.MANA_EMBEDDER_IDLE_MS),
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
  // query: the texts are search queries (the user's message), not stored
  // documents -- they get QUERY_PROMPT and are cut, never chunked.
  async function embed(inputs, { query = false } = {}) {
    const coordinator = options.resourceCoordinator || require('../utils/resource-service').getResourceService();
    const background = query ? false : coordinator?.currentContext()?.background ?? true;
    const out = inputs.map(() => null);
    if (!out.length) return out;
    const prompt = query && /qwen3-embedding/i.test(path.basename(modelPath() || "")) ? QUERY_PROMPT : "";
    const pieces = inputs.map((t) =>
      query ? [Array.from(prompt + String(t || "")).slice(0, MAX_TOKENS).join("")] : chunks(String(t || "")),
    );
    const input = pieces.flat();
    try {
      await server.use(async () => {
      const resp = await fetchImpl(`http://127.0.0.1:${port()}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = await resp.json();
      const vectors = input.map(() => null);
      for (const d of Array.isArray(body?.data) ? body.data : []) {
        if (Number.isInteger(d?.index) && d.index >= 0 && d.index < input.length && Array.isArray(d.embedding)) {
          vectors[d.index] = d.embedding;
        }
      }
      let next = 0;
      pieces.forEach((p, i) => {
        const vs = vectors.slice(next, (next += p.length));
        if (vs.every(Array.isArray)) out[i] = vs.length === 1 ? vs[0] : unitMean(vs);
      });
      }, { owner: 'Memory embeddings', background, estimate: { cpu: threads } });
    } catch (e) {
      console.warn("Embedding llama-server unavailable:", e?.message || e);
    }
    return out;
  }

  // Starts the server ahead of use (backend startup, the start of a user
  // turn), so the recall that follows doesn't wait out the cold start.
  // Never throws; concurrent calls share one start. Not while gaming.
  function warm() {
    if (isEnabled() && !gaming()) server.ensure({ background: true }).then(server.touch, () => {});
  }

  return { embed, warm, isEnabled, modelId, stop: server.stop };
}

module.exports = { createEmbedder, QUERY_PROMPT };
