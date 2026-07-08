const retriever = require('./retriever-index');
const fs = require('fs');
const path = require('path');

let running = false;
let queue = [];
let total = 0;
let processed = 0;
let lastError = null;
let workerPromise = null;

const DEFAULT_DELAY_MS = Number(process.env.RETRIEVER_EMBED_BATCH_DELAY_MS || 100);
const CONCURRENCY = Math.max(1, Number(process.env.RETRIEVER_EMBED_CONCURRENCY || 1));

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
  if (!running) startWorker(opts).catch((err) => {
    console.warn('embedding worker failed:', err?.message || err);
  });
  return { queued: queue.length, total };
}

async function startWorker(opts = {}) {
  if (running) return;
  if (process.env.NODE_ENV === 'test') return; // don't run in tests
  running = true;
  lastError = null;
  try {
    while (queue.length > 0) {
      const batch = [];
      for (let i = 0; i < CONCURRENCY && queue.length > 0; i++) batch.push(queue.shift());
      // process batch in parallel up to CONCURRENCY
      await Promise.all(batch.map(async (p) => {
        try {
          const txt = await fs.promises.readFile(p, 'utf8').catch(() => '');
          const excerpt = String(txt).slice(0, 8192);
          const emb = await retriever.computeEmbedding(excerpt);
          if (emb && Array.isArray(emb)) {
            // update index entry
            const idx = retriever.loadIndexSync();
            const found = (idx.entries || []).find((en) => en.path === p || en.id === p);
            if (found) {
              found.embedding = emb;
              await retriever.saveIndex ? retriever.saveIndex(idx).catch(()=>{}) : (async()=>{})();
            }
          } else {
            // mark as attempted with null embedding to avoid endless retries
            const idx = retriever.loadIndexSync();
            const found = (idx.entries || []).find((en) => en.path === p || en.id === p);
            if (found) {
              found.embedding = found.embedding || [];
              await retriever.saveIndex ? retriever.saveIndex(idx).catch(()=>{}) : (async()=>{})();
            }
          }
          processed += 1;
          // small delay to respect rate limits
          await new Promise((r) => setTimeout(r, DEFAULT_DELAY_MS));
        } catch (e) {
          lastError = String(e?.message || e);
        }
      }));
    }
  } finally {
    running = false;
  }
}

module.exports = { enqueueAll, startWorker, status };
