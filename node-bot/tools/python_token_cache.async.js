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

async function countTokensForPath(filePath, rebuild = false) {
  const res = await sendRequest({
    method: "count_path",
    path: filePath,
    rebuild,
  });
  if (res && typeof res.tokens === "number") return res.tokens;
  throw new Error(res && res.error ? res.error : "no_tokens");
}

async function countTokensForText(text, ext = ".py", rebuild = false) {
  const res = await sendRequest({ method: "count_text", text, ext, rebuild });
  if (res && typeof res.tokens === "number") return res.tokens;
  throw new Error(res && res.error ? res.error : "no_tokens");
}

module.exports = { countTokensForPath, countTokensForText };
