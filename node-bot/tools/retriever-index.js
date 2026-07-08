const fs = require("fs");
const path = require("path");

const INDEX_PATH = path.join(__dirname, "..", "data", "retriever_index.json");

// Embedding settings
const USE_EMBEDDINGS =
  String(process.env.USE_EMBEDDINGS || "").toLowerCase() === "1" ||
  String(process.env.USE_EMBEDDINGS || "").toLowerCase() === "true";
const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL ||
  process.env.OPENAI_EMBEDDING_MODEL ||
  "text-embedding-3-small";
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com";

// Vector store adapter (FAISS or JS fallback)
const { createStore } = require("./vector-store");
const VECTOR_STORE_DIR =
  process.env.VECTOR_STORE_DIR ||
  path.join(__dirname, "..", "tools", "vector_store");
const vectorStore = createStore({ dir: VECTOR_STORE_DIR });

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  const n = normalize(text);
  if (!n) return [];
  return n.split(" ").filter(Boolean);
}

function termFreq(tokens) {
  const tf = Object.create(null);
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  return tf;
}

function ensureDataDir() {
  try {
    fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
  } catch (e) {}
}

function loadIndexSync() {
  try {
    if (!fs.existsSync(INDEX_PATH))
      return { version: 1, builtAt: null, entries: [], meta: {} };
    const txt = fs.readFileSync(INDEX_PATH, "utf8") || "";
    return JSON.parse(txt || "{}");
  } catch (e) {
    return { version: 1, builtAt: null, entries: [], meta: {} };
  }
}

async function saveIndex(idx) {
  try {
    ensureDataDir();
    const tmp = INDEX_PATH + ".tmp";
    await fs.promises.writeFile(tmp, JSON.stringify(idx, null, 2), "utf8");
    await fs.promises.rename(tmp, INDEX_PATH);
  } catch (e) {
    // ignore
  }
}

async function buildIndex(options = {}) {
  // Full rebuild: options: roots: array of absolute paths to scan; maxFiles, exts
  const roots =
    options.roots && options.roots.length
      ? options.roots
      : [process.env.RETRIEVER_INDEX_ROOT || path.resolve(__dirname, "..")];
  const exts = options.exts || [
    ".md",
    ".txt",
    ".py",
    ".js",
    ".json",
    ".mdx",
    ".html",
  ];
  const maxFiles = Number(
    options.maxFiles || Number(process.env.RETRIEVER_INDEX_MAX_FILES || 2000),
  );
  const entries = [];

  let seen = 0;

  async function scanDir(root) {
    try {
      const stats = await fs.promises.stat(root);
      if (stats.isFile()) {
        const ext = path.extname(root).toLowerCase();
        if (exts.includes(ext)) {
          await addFile(root);
        }
        return;
      }
    } catch (e) {
      return;
    }

    const walker = [root];
    while (walker.length && seen < maxFiles) {
      const cur = walker.pop();
      let names = [];
      try {
        names = await fs.promises.readdir(cur);
      } catch (e) {
        continue;
      }
      for (const name of names) {
        if (seen >= maxFiles) break;
        const p = path.join(cur, name);
        try {
          const st = await fs.promises.stat(p);
          if (st.isDirectory()) {
            walker.push(p);
            continue;
          }
          const ext = path.extname(p).toLowerCase();
          if (!exts.includes(ext)) continue;
          await addFile(p, st);
        } catch (e) {
          continue;
        }
      }
    }
  }

  async function addFile(p, st) {
    try {
      const stat = st || (await fs.promises.stat(p));
      const raw = await fs.promises.readFile(p, "utf8").catch(() => "");
      const text = String(raw).slice(0, 20000); // cap per file
      const tokens = tokenize(text);
      const tf = termFreq(tokens);
      const id = path.resolve(p);
      const entry = {
        id,
        path: id,
        mtime: stat.mtimeMs,
        tokens: Object.keys(tf),
        tf,
      };
      // optionally compute embedding (skip in tests)
      if (USE_EMBEDDINGS && process.env.NODE_ENV !== "test" && OPENAI_API_KEY) {
        try {
          const emb = await computeEmbedding(text);
          if (emb && Array.isArray(emb)) entry.embedding = emb;
        } catch (e) {}
      }
      entries.push(entry);
      seen += 1;
    } catch (e) {}
  }

  for (const r of roots) {
    await scanDir(r);
  }

  const idx = {
    version: 1,
    builtAt: new Date().toISOString(),
    entries,
    meta: { root: roots, exts, count: entries.length },
  };
  await saveIndex(idx);
  return idx;
}

async function incrementalScan(options = {}) {
  // Incrementally update existing index by scanning roots and comparing mtimes
  const roots =
    options.roots && options.roots.length
      ? options.roots
      : [process.env.RETRIEVER_INDEX_ROOT || path.resolve(__dirname, "..")];
  const exts = options.exts || [
    ".md",
    ".txt",
    ".py",
    ".js",
    ".json",
    ".mdx",
    ".html",
  ];
  const maxFiles = Number(
    options.maxFiles || Number(process.env.RETRIEVER_INDEX_MAX_FILES || 2000),
  );

  const idx = loadIndexSync();
  const map = Object.create(null);
  if (Array.isArray(idx.entries)) {
    for (const e of idx.entries) map[e.path] = e;
  }

  const added = [];
  const updated = [];
  const removed = [];
  let seen = 0;

  async function scanDir(root) {
    try {
      const stats = await fs.promises.stat(root);
      if (stats.isFile()) {
        const ext = path.extname(root).toLowerCase();
        if (exts.includes(ext)) {
          await upsertFile(root);
        }
        return;
      }
    } catch (e) {
      return;
    }

    const walker = [root];
    while (walker.length && seen < maxFiles) {
      const cur = walker.pop();
      let names = [];
      try {
        names = await fs.promises.readdir(cur);
      } catch (e) {
        continue;
      }
      for (const name of names) {
        if (seen >= maxFiles) break;
        const p = path.join(cur, name);
        try {
          const st = await fs.promises.stat(p);
          if (st.isDirectory()) {
            walker.push(p);
            continue;
          }
          const ext = path.extname(p).toLowerCase();
          if (!exts.includes(ext)) continue;
          await upsertFile(p, st);
        } catch (e) {
          continue;
        }
      }
    }
  }

  async function upsertFile(p, st) {
    try {
      const stat = st || (await fs.promises.stat(p));
      const abs = path.resolve(p);
      seen += 1;
      const prev = map[abs];
      if (prev && prev.mtime === stat.mtimeMs) {
        // unchanged
        return;
      }
      const raw = await fs.promises.readFile(p, "utf8").catch(() => "");
      const text = String(raw).slice(0, 20000);
      const tokens = tokenize(text);
      const tf = termFreq(tokens);
      const entry = {
        id: abs,
        path: abs,
        mtime: stat.mtimeMs,
        tokens: Object.keys(tf),
        tf,
      };
      map[abs] = entry;
      if (prev) updated.push(abs);
      else added.push(abs);
      // Optionally compute embedding (async) when enabled (skip during tests)
      if (USE_EMBEDDINGS && process.env.NODE_ENV !== "test") {
        try {
          const emb = await computeEmbedding(text);
          if (emb && Array.isArray(emb)) map[abs].embedding = emb;
        } catch (e) {}
      }
    } catch (e) {
      // skip
    }
  }

  for (const r of roots) {
    await scanDir(r);
  }

  // detect removed files
  const pathsSeen = new Set(Object.keys(map));
  for (const p of Object.keys(map)) {
    try {
      if (!fs.existsSync(p)) {
        removed.push(p);
        delete map[p];
      }
    } catch (e) {}
  }

  const entries = Object.keys(map).map((k) => map[k]);
  const out = {
    version: 1,
    builtAt: new Date().toISOString(),
    entries,
    meta: {
      roots,
      exts,
      added: added.length,
      updated: updated.length,
      removed: removed.length,
      count: entries.length,
    },
  };
  await saveIndex(out);
  return {
    added,
    updated,
    removed,
    count: entries.length,
    builtAt: out.builtAt,
  };
}

async function computeEmbedding(text) {
  const res = await computeEmbeddings([String(text || "").slice(0, 8192)]);
  return Array.isArray(res) && res.length ? res[0] : null;
}

async function computeEmbeddings(inputs) {
  // inputs: array of strings
  if (!USE_EMBEDDINGS) return inputs.map(() => null);
  if (process.env.NODE_ENV === "test") return inputs.map(() => null);

  const localUrl = (
    process.env.RETRIEVER_EMBEDDER_URL || "http://127.0.0.1:9001"
  ).replace(/\/$/, "");
  const embedderSecret = process.env.RETRIEVER_EMBEDDER_SECRET || null;

  // Try local embedder batch endpoint
  try {
    const resp = await fetch(localUrl + "/embed", {
      method: "POST",
      headers: Object.assign(
        { "Content-Type": "application/json" },
        embedderSecret ? { Authorization: "Bearer " + embedderSecret } : {},
      ),
      body: JSON.stringify({
        inputs: inputs.map((t) => String(t || "").slice(0, 8192)),
      }),
    });
    if (resp.ok) {
      const j = await resp.json();
      if (j && Array.isArray(j.embeddings))
        return j.embeddings.map((arr) => (Array.isArray(arr) ? arr : null));
    }
  } catch (e) {
    // local embedder not available
  }

  // Fallback to OpenAI batch embeddings
  if (!OPENAI_API_KEY) return inputs.map(() => null);
  try {
    const url =
      (OPENAI_BASE_URL || "https://api.openai.com").replace(/\/$/, "") +
      "/v1/embeddings";
    const body = JSON.stringify({
      model: EMBEDDING_MODEL,
      input: inputs.map((t) => String(t || "").slice(0, 8192)),
    });
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + OPENAI_API_KEY,
      },
      body,
    });
    if (!resp.ok) return inputs.map(() => null);
    const j = await resp.json();
    if (j && Array.isArray(j.data)) {
      return j.data.map((d) =>
        d && Array.isArray(d.embedding) ? d.embedding : null,
      );
    }
  } catch (e) {
    return inputs.map(() => null);
  }
  return inputs.map(() => null);
}

function dot(a, b) {
  let s = 0.0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += (a[i] || 0) * (b[i] || 0);
  return s;
}

function norm(a) {
  let s = 0.0;
  for (let i = 0; i < a.length; i++) s += (a[i] || 0) * (a[i] || 0);
  return Math.sqrt(s);
}

function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length)
    return 0;
  const d = dot(a, b);
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  return d / (na * nb);
}

function scoreTf(queryTokens, entry) {
  if (!queryTokens.length) return 0;
  let s = 0;
  const tf = entry.tf || {};
  for (const t of queryTokens) s += tf[t] || 0;
  return s;
}

function searchSync(query, k = 5) {
  const idx = loadIndexSync();
  if (!idx || !Array.isArray(idx.entries) || idx.entries.length === 0)
    return [];
  // If embeddings present, prefer embedding-based search synchronously is not supported here
  const qtokens = tokenize(query);
  const scored = idx.entries.map((e) => ({ e, score: scoreTf(qtokens, e) }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored
    .filter((s) => s.score > 0)
    .slice(0, k)
    .map((s) => ({ id: s.e.id, path: s.e.path, score: s.score }));
  return top;
}

async function search(query, k = 5) {
  // If embeddings are enabled and index entries have embeddings, perform embedding search
  const idx = loadIndexSync();
  const out = [];
  const hasEmbedding =
    idx &&
    Array.isArray(idx.entries) &&
    idx.entries.length &&
    Array.isArray(idx.entries[0].embedding);
  if (USE_EMBEDDINGS && hasEmbedding) {
    // compute query embedding
    const qembed = await computeEmbedding(query);
    if (!qembed) {
      // fall back to tf search
      const tops = searchSync(query, k);
      for (const t of tops) {
        try {
          const raw = await fs.promises
            .readFile(t.path, "utf8")
            .catch(() => "");
          const snippet = String(raw).slice(0, 800);
          out.push({ id: t.id, path: t.path, score: t.score, snippet });
        } catch (e) {
          out.push({ id: t.id, path: t.path, score: t.score, snippet: "" });
        }
      }
      return out;
    }
    // score by cosine similarity
    const scored = [];
    for (const e of idx.entries) {
      if (!Array.isArray(e.embedding)) continue;
      const s = cosineSim(qembed, e.embedding);
      scored.push({ e, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, k);
    for (const t of top) {
      try {
        const raw = await fs.promises
          .readFile(t.e.path, "utf8")
          .catch(() => "");
        const snippet = String(raw).slice(0, 800);
        out.push({ id: t.e.id, path: t.e.path, score: t.score, snippet });
      } catch (e) {
        out.push({ id: t.e.id, path: t.e.path, score: t.score, snippet: "" });
      }
    }
    return out;
  }
  // fallback to tf
  const tops = searchSync(query, k);
  for (const t of tops) {
    try {
      const raw = await fs.promises.readFile(t.path, "utf8").catch(() => "");
      const snippet = String(raw).slice(0, 800);
      out.push({ id: t.id, path: t.path, score: t.score, snippet });
    } catch (e) {
      out.push({ id: t.id, path: t.path, score: t.score, snippet: "" });
    }
  }
  return out;
}

async function buildVectorStore(options = {}) {
  // Build or rebuild a separate vector store from entries which contain embeddings
  const storeDir = options.dir || VECTOR_STORE_DIR;
  const store = createStore ? createStore({ dir: storeDir }) : null;
  if (!store) return { ok: false, reason: "no_vector_store" };
  await store.init();
  await store.load();
  const idx = loadIndexSync();
  const entries = Array.isArray(idx.entries) ? idx.entries : [];
  let added = 0;
  for (const e of entries) {
    if (e && Array.isArray(e.embedding) && e.embedding.length) {
      try {
        await store.add(e.id, e.embedding, { path: e.path });
        added += 1;
      } catch (err) {
        // ignore individual failures
      }
    }
  }
  try {
    if (typeof store.buildIndex === "function") await store.buildIndex();
    await store.save();
  } catch (e) {}
  const cnt = await store.count();
  return { ok: true, added, count: cnt };
}

module.exports = {
  buildIndex,
  incrementalScan,
  buildVectorStore,
  search,
  searchSync,
  loadIndexSync,
  INDEX_PATH,
  computeEmbedding,
  computeEmbeddings,
  cosineSim,
  saveIndex,
};
