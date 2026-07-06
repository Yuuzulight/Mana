const { spawn } = require("child_process");
const path = require("path");

const PY_SCRIPT = path.join(__dirname, "python_token_cache.py");
const PY_BIN = process.env.PYTHON || "python";
const STARTUP_ARGS = ["--serve-stdio"];

let child = null;
let pending = new Map();
let buf = "";
let nextId = 1;

function ensureChild() {
  if (child && !child.killed) return;
  child = spawn(PY_BIN, [PY_SCRIPT, "--serve-stdio"], {
    stdio: ["pipe", "pipe", "inherit"],
  });

  child.stdout.on("data", (c) => {
    buf += c.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        const id = obj && obj.id;
        if (id && pending.has(id)) {
          const { resolve, reject, timeout } = pending.get(id);
          clearTimeout(timeout);
          pending.delete(id);
          if (obj.ok) resolve(obj);
          else reject(new Error(obj.error || "python_error"));
        }
      } catch (e) {
        // ignore
      }
    }
  });

  child.on("exit", (code) => {
    // reject all pending
    for (const [id, { reject }] of pending.entries()) {
      try {
        reject(new Error("python_daemon_exit"));
      } catch (e) {}
    }
    pending.clear();
    child = null;
  });
}

function sendRequest(req, timeoutMs = 20000) {
  ensureChild();
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
    pending.set(id, { resolve: (obj) => resolve(obj), reject, timeout });
    try {
      child.stdin.write(line);
    } catch (e) {
      clearTimeout(timeout);
      pending.delete(id);
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
