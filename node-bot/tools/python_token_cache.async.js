const { spawn } = require("child_process");
const path = require("path");

const PY_SCRIPT = path.join(__dirname, "python_token_cache.py");
const PY_BIN = process.env.PYTHON || "python";
const STARTUP_ARGS = ["--serve-stdio"];

let children = [];
let nextWorker = 0;
let pending = new Map();
let nextId = 1;

const DEFAULT_POOL = Math.max(1, Number(process.env.PY_TOKEN_POOL_SIZE || 2));

function spawnWorker() {
  const w = spawn(PY_BIN, [PY_SCRIPT, "--serve-stdio"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  w._buf = "";
  w._pendingIds = new Set();

  w.stdout.on("data", (c) => {
    w._buf += c.toString();
    let idx;
    while ((idx = w._buf.indexOf("\n")) >= 0) {
      const line = w._buf.slice(0, idx).trim();
      w._buf = w._buf.slice(idx + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        const id = obj && obj.id;
        if (id && pending.has(id)) {
          const { resolve, reject, timeout, worker } = pending.get(id);
          clearTimeout(timeout);
          pending.delete(id);
          worker._pendingIds.delete(id);
          if (obj.ok) resolve(obj);
          else reject(new Error(obj.error || "python_error"));
        }
      } catch (e) {
        // ignore
      }
    }
  });

  w.on("exit", (code) => {
    // reject our worker's pending ids
    for (const id of Array.from(w._pendingIds)) {
      if (pending.has(id)) {
        const { reject } = pending.get(id);
        try {
          reject(new Error("python_worker_exit"));
        } catch (e) {}
        pending.delete(id);
      }
    }
    // replace worker
    const i = children.indexOf(w);
    if (i >= 0) children.splice(i, 1);
    // spawn a replacement after a small delay
    setTimeout(() => {
      try {
        children.push(spawnWorker());
      } catch (e) {}
    }, 1000);
  });
  return w;
}

function ensurePool() {
  if (children.length >= DEFAULT_POOL) return;
  while (children.length < DEFAULT_POOL) {
    children.push(spawnWorker());
  }
}

function sendRequest(req, timeoutMs = 20000) {
  ensurePool();
  return new Promise((resolve, reject) => {
    const id = String(nextId++);
    const payload = Object.assign({}, req, { id });
    const line = JSON.stringify(payload) + "\n";
    const timeout = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("python_request_timeout"));
      }
    }, timeoutMs);

    // pick next worker round-robin
    const worker = children[nextWorker % children.length];
    nextWorker = (nextWorker + 1) % Math.max(1, children.length);
    pending.set(id, {
      resolve: (obj) => resolve(obj),
      reject,
      timeout,
      worker,
    });
    worker._pendingIds.add(id);
    try {
      worker.stdin.write(line);
    } catch (e) {
      clearTimeout(timeout);
      pending.delete(id);
      worker._pendingIds.delete(id);
      reject(e);
    }
  });
}

const fs = require("fs");
const os = require("os");

function heuristicCount(text) {
  const b = Buffer.from(String(text || ""), "utf8");
  return Math.max(1, Math.ceil(b.length / 4));
}

function cachePath() {
  return path.join(__dirname, "..", "data", "token_count_cache.json");
}

function readCacheSync() {
  try {
    const p = cachePath();
    if (!fs.existsSync(p)) return {};
    const txt = fs.readFileSync(p, "utf8") || "";
    return JSON.parse(txt || "{}") || {};
  } catch (e) {
    return {};
  }
}

function writeCacheSync(cache) {
  try {
    const p = cachePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
    fs.renameSync(tmp, p);
  } catch (e) {
    // ignore
  }
}

async function fallbackCountPath(filePath, rebuild = false) {
  try {
    const abs = path.resolve(String(filePath));
    const stat = fs.statSync(abs);
    const cache = readCacheSync();
    const entry = cache[abs];
    const fp = `${abs}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
    if (
      !rebuild &&
      entry &&
      entry.fingerprint === fp &&
      Number.isInteger(entry.tokens)
    ) {
      return entry.tokens;
    }
    const text = fs.readFileSync(abs, "utf8");
    const tokens = heuristicCount(text);
    cache[abs] = {
      path: abs,
      size: stat.size,
      mtime: stat.mtimeMs,
      fingerprint: fp,
      tokens,
    };
    writeCacheSync(cache);
    return tokens;
  } catch (e) {
    // fallback minimal
    return heuristicCount("");
  }
}

async function fallbackCountText(text, ext = ".py", rebuild = false) {
  try {
    // write temp file
    const tmp = path.join(
      os.tmpdir(),
      `mana-tok-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`,
    );
    fs.writeFileSync(tmp, String(text || ""), "utf8");
    const tokens = await fallbackCountPath(tmp, rebuild);
    try {
      fs.unlinkSync(tmp);
    } catch (e) {}
    return tokens;
  } catch (e) {
    return heuristicCount(text);
  }
}

async function countTokensForPath(filePath, rebuild = false) {
  try {
    const res = await sendRequest({
      method: "count_path",
      path: filePath,
      rebuild,
    });
    if (res && typeof res.tokens === "number") return res.tokens;
    // otherwise, fallback
    return await fallbackCountPath(filePath, rebuild);
  } catch (e) {
    return await fallbackCountPath(filePath, rebuild);
  }
}

async function countTokensForText(text, ext = ".py", rebuild = false) {
  try {
    const res = await sendRequest({ method: "count_text", text, ext, rebuild });
    if (res && typeof res.tokens === "number") return res.tokens;
    return await fallbackCountText(text, ext, rebuild);
  } catch (e) {
    return await fallbackCountText(text, ext, rebuild);
  }
}

if (process.env.NODE_ENV === "test") {
  // In tests, avoid spawning Python workers — use fast JS fallback implementations to keep tests deterministic and avoid lingering child processes.
  module.exports = {
    countTokensForPath: fallbackCountPath,
    countTokensForText: fallbackCountText,
  };
} else {
  module.exports = { countTokensForPath, countTokensForText };
}
