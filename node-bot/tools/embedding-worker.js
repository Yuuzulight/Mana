const retriever = require("./retriever-index");
const fs = require("fs");
const path = require("path");

let running = false;
let queue = [];
let total = 0;
let processed = 0;
let lastError = null;
let workerPromise = null;

const DEFAULT_DELAY_MS = Number(
  process.env.RETRIEVER_EMBED_BATCH_DELAY_MS || 100,
);
const CONCURRENCY = Math.max(
  1,
  Number(process.env.RETRIEVER_EMBED_CONCURRENCY || 1),
);

function status() {
  return {
    running,
    total,
    processed,
    remaining: Math.max(0, queue.length),
    lastError,
  };
}

async function enqueueAll(opts = {}) {
  // load index and enqueue entries missing embeddings
  const idx = retriever.loadIndexSync();
  const entries = Array.isArray(idx.entries) ? idx.entries : [];
  const toQueue = [];
  for (const e of entries) {
    if (!Array.isArray(e.embedding) || e.embedding.length === 0) {
      toQueue.push(e.path);
    }
  }
  // dedupe and set queue
  const set = new Set(queue.concat(toQueue));
  queue = Array.from(set);
  total = queue.length + processed;
  // start worker if not running
  if (!running)
    startWorker(opts).catch((err) => {
      console.warn("embedding worker failed:", err?.message || err);
    });
  return { queued: queue.length, total };
}

async function startWorker(opts = {}) {
  if (running) return;
  if (process.env.NODE_ENV === "test") return; // don't run in tests
  running = true;
  lastError = null;
  try {
    while (queue.length > 0) {
      // Build a batch of up to batchSize items (batch size tuned via env)
      const batchSize = Math.max(
        1,
        Number(process.env.RETRIEVER_EMBED_BATCH_SIZE || 8),
      );
      const batch = [];
      while (batch.length < batchSize && queue.length > 0)
        batch.push(queue.shift());

      // Read files and prepare inputs
      const paths = batch.slice();
      const texts = await Promise.all(
        paths.map(
          async (p) => await fs.promises.readFile(p, "utf8").catch(() => ""),
        ),
      );
      const excerpts = texts.map((t) => String(t || "").slice(0, 8192));
      try {
        const embeddings = await retriever.computeEmbeddings(excerpts);
        // load index once and update for all
        const idx = retriever.loadIndexSync();
        let changed = false;
        for (let i = 0; i < paths.length; i++) {
          const p = paths[i];
          const emb = Array.isArray(embeddings) ? embeddings[i] : null;
          const found = (idx.entries || []).find(
            (en) => en.path === p || en.id === p,
          );
          if (found) {
            if (emb && Array.isArray(emb)) {
              found.embedding = emb;
            } else {
              found.embedding = found.embedding || [];
            }
            changed = true;
          }
          processed += 1;
        }
        if (changed)
          (await retriever.saveIndex)
            ? retriever.saveIndex(idx).catch(() => {})
            : (async () => {})();
      } catch (e) {
        lastError = String(e?.message || e);
        // if batch failed, fallback to per-file attempts to avoid stalling
        for (let i = 0; i < paths.length; i++) {
          const p = paths[i];
          try {
            const excerpt = excerpts[i];
            const emb = await retriever.computeEmbedding(excerpt);
            const idx = retriever.loadIndexSync();
            const found = (idx.entries || []).find(
              (en) => en.path === p || en.id === p,
            );
            if (found) {
              if (emb && Array.isArray(emb)) found.embedding = emb;
              else found.embedding = found.embedding || [];
              (await retriever.saveIndex)
                ? retriever.saveIndex(idx).catch(() => {})
                : (async () => {})();
            }
            processed += 1;
            await new Promise((r) => setTimeout(r, DEFAULT_DELAY_MS));
          } catch (e2) {
            lastError = String(e2?.message || e2);
          }
        }
      }
      // small delay between batches
      await new Promise((r) => setTimeout(r, DEFAULT_DELAY_MS));
    }
  } finally {
    running = false;
  }
}

module.exports = { enqueueAll, startWorker, status };
