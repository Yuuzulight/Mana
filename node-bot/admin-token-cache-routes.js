// /admin/token-cache routes, kept out of server.js as part of #500.
const fs = require("fs");
const path = require("path");

function cachePath(dataDir = path.join(__dirname, "data")) {
  return path.join(dataDir, "token_count_cache.json");
}

function registerAdminTokenCacheRoutes(app, deps = {}) {
  const {
    checkAdminAuth,
    dataDir = path.join(__dirname, "data"),
    env = process.env,
    fetchImpl,
  } = deps;
  if (typeof checkAdminAuth !== "function") {
    throw new Error("checkAdminAuth is required");
  }

  app.get("/admin/token-cache", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const file = cachePath(dataDir);
      if (!fs.existsSync(file)) return res.json({ ok: true, keys: [], count: 0 });
      const txt = await fs.promises.readFile(file, "utf8");
      const obj = JSON.parse(txt || "{}");
      const keys = Object.keys(obj);
      return res.json({ ok: true, keys, count: keys.length });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });

  app.post("/admin/token-cache/evict", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const p = typeof req.body?.path === "string" ? req.body.path : null;
      if (!p) return res.status(400).json({ ok: false, error: "path required" });
      const file = cachePath(dataDir);
      let cache = {};
      try {
        if (fs.existsSync(file)) {
          cache = JSON.parse((await fs.promises.readFile(file, "utf8")) || "{}");
        }
      } catch {
        cache = {};
      }
      const key = path.resolve(p);
      if (cache[key]) delete cache[key];
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, JSON.stringify(cache, null, 2), "utf8");
      return res.json({ ok: true, evicted: key });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });

  app.get("/admin/token-cache-metrics", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const pyPort = Number(env.PY_TOKEN_SERVER_PORT || 9000);
      const pySecret = env.PY_TOKEN_SERVER_SECRET || null;
      const headers = {};
      if (pySecret) headers.Authorization = `Bearer ${pySecret}`;
      const fetch = fetchImpl || require("node-fetch");
      const resp = await fetch(`http://127.0.0.1:${pyPort}/metrics`, { headers, method: "GET" });
      const body = await resp.text();
      try {
        const parsed = JSON.parse(body);
        return res.json({ ok: true, metrics: parsed.metrics || parsed });
      } catch {
        return res.status(502).json({ ok: false, error: "invalid_metrics_response" });
      }
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });
}

module.exports = { cachePath, registerAdminTokenCacheRoutes };
