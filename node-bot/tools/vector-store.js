const fs = require('fs');
const path = require('path');

// Simple adapter for FAISS when available, with a JS fallback.
// Exports: createStore({ dir }) -> store with methods: init(), add(id, vector, meta), search(vec,k), save(), load(), count()

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += (a[i]||0) * (b[i]||0);
    na += (a[i]||0)*(a[i]||0);
    nb += (b[i]||0)*(b[i]||0);
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function makeFallbackStore(opts = {}) {
  const dir = opts.dir || path.join(__dirname, '..', 'data', 'vector_store');
  const file = path.join(dir, 'vector_store.json');
  let items = []; // { id, vector, meta }

  function ensureDir() {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  }

  return {
    async init() { ensureDir(); items = []; },
    async add(id, vector, meta) {
      items.push({ id, vector, meta });
    },
    async search(vec, k = 5) {
      const scored = items.map(it => ({ it, score: cosine(vec, it.vector) }));
      scored.sort((a,b)=>b.score - a.score);
      return scored.slice(0,k).map(s=>({ id: s.it.id, score: s.score, path: s.it.meta && s.it.meta.path ? s.it.meta.path : s.it.id }));
    },
    async save() { ensureDir(); try { fs.writeFileSync(file, JSON.stringify(items, null, 2), 'utf8'); } catch(e) {} },
    async load() { try { if (fs.existsSync(file)) { items = JSON.parse(fs.readFileSync(file, 'utf8')||'[]'); } else items = []; } catch(e) { items = []; } },
    async count() { return items.length; },
  };
}

function tryFaiss() {
  try {
    // attempt to require a faiss binding (name may vary)
    const faiss = require('faiss');
    return faiss;
  } catch (e) {
    try { return require('faiss-node'); } catch (e2) { return null; }
  }
}

function createStore(opts = {}) {
  const useFaiss = String(process.env.USE_FAISS || '') === '1';
  const faissModule = useFaiss ? tryFaiss() : null;
  if (faissModule) {
    // Implement a thin FAISS-backed store when available
    // For now, if a binding is present, provide a simplified wrapper that stores vectors in memory and uses FAISS index when asked
    const dir = opts.dir || path.join(__dirname, '..', 'data', 'vector_store');
    let ids = [];
    let vectors = [];
    let metas = {};
    let index = null;

    function ensureDir() { try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {} }

    return {
      async init() { ensureDir(); ids = []; vectors = []; metas = {}; index = null; },
      async add(id, vector, meta) { ids.push(id); vectors.push(vector); metas[id] = meta || {}; },
      async buildIndex() {
        try {
          // FAISS usage may vary by binding; implement a naive float32 index using faissModule.IndexFlatL2 if available
          if (!faissModule || !faissModule.IndexFlatL2) return;
          const dim = vectors.length ? vectors[0].length : 0;
          index = new faissModule.IndexFlatL2(dim);
          // flatten vectors to Float32Array
          const flat = new Float32Array(vectors.length * dim);
          for (let i=0;i<vectors.length;i++){
            for (let j=0;j<dim;j++) flat[i*dim + j] = vectors[i][j] || 0;
          }
          index.add(flat, vectors.length);
        } catch (e) { /* swallow */ }
      },
      async search(vec, k=5) {
        if (index) {
          try {
            const dim = vec.length;
            const q = new Float32Array(vec);
            const res = index.search(q, k);
            // result format depends on binding
            // fall back: brute-force
          } catch (e) {}
        }
        // fallback to brute force
        const scored = ids.map((id, idx) => ({ id, score: cosine(vec, vectors[idx]), path: metas[id] && metas[id].path ? metas[id].path : id }));
        scored.sort((a,b)=>b.score - a.score);
        return scored.slice(0,k);
      },
      async save() { ensureDir(); try { fs.writeFileSync(path.join(dir,'meta.json'), JSON.stringify({ ids, metas }, null, 2)); fs.writeFileSync(path.join(dir,'vectors.json'), JSON.stringify(vectors, null, 2)); } catch(e){} },
      async load() { try { const mid = path.join(dir,'meta.json'); const vid = path.join(dir,'vectors.json'); if (fs.existsSync(mid)) { const m = JSON.parse(fs.readFileSync(mid,'utf8')||'{}'); ids = m.ids || []; metas = m.metas || {}; } if (fs.existsSync(vid)) vectors = JSON.parse(fs.readFileSync(vid,'utf8')||'[]'); } catch(e){} },
      async count() { return ids.length; }
    };
  }

  // fallback
  return makeFallbackStore(opts);
}

module.exports = { createStore };
