const path = require("path");
const { scanDir } = require("../tools/dir_scanner");

const KEY = "dirScanner";

function registerRoutes(app, context = {}) {
  const repoRoot =
    (context && context.REPO_ROOT) ||
    process.env.REPO_ROOT ||
    path.resolve(__dirname, "..", "..");
  const ADMIN_SECRET =
    (context && context.MANA_ADMIN_SECRET) ||
    process.env.MANA_ADMIN_SECRET ||
    "";

  function checkAdminAuth(req, res) {
    if (!ADMIN_SECRET) return true; // no secret -> allow (local dev)
    const header = req.get("authorization") || req.get("Authorization") || "";
    if (!header || !header.startsWith("Bearer ")) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return false;
    }
    const token = header.slice(7).trim();
    if (token !== ADMIN_SECRET) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return false;
    }
    return true;
  }

  app.get("/tools/dir-scan", (req, res) => {
    try {
      if (!checkAdminAuth(req, res)) return;

      const reqPath =
        typeof req.query.path === "string" && req.query.path.trim()
          ? req.query.path.trim()
          : ".";
      // Resolve and sandbox to repoRoot
      let resolved = reqPath;
      if (!path.isAbsolute(reqPath)) {
        resolved = path.resolve(repoRoot, reqPath);
      }
      const rel = path.relative(repoRoot, resolved);
      if (rel.startsWith("..")) {
        return res.status(400).json({ ok: false, error: "path_outside_repo" });
      }

      const maxDepth = Number(req.query.maxDepth || 10);
      const exts =
        typeof req.query.ext === "string" && req.query.ext.trim()
          ? req.query.ext
              .split(",")
              .map((s) => s.trim().toLowerCase())
              .filter(Boolean)
          : null;
      const exclude =
        typeof req.query.exclude === "string" && req.query.exclude.trim()
          ? req.query.exclude
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [];

      const limit =
        req.query.limit !== undefined
          ? Math.max(0, Number(req.query.limit) || 0)
          : null;
      const offset =
        req.query.offset !== undefined
          ? Math.max(0, Number(req.query.offset) || 0)
          : 0;
      const useIndex =
        req.query.useIndex === "1" ||
        req.query.useIndex === "true" ||
        req.query.useIndex === true;

      const listObj = scanDir(resolved, {
        path: resolved,
        maxDepth,
        exts,
        exclude,
        limit,
        offset,
        useIndex,
      });

      // listObj: { items, total, nextToken }
      const items = Array.isArray(listObj) ? listObj : listObj.items || [];
      const total =
        listObj && typeof listObj.total === "number"
          ? listObj.total
          : items.length;
      const nextToken = listObj && listObj.nextToken ? listObj.nextToken : null;
      return res.json({ ok: true, files: items, total, nextToken });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });
}

function getHealth() {
  return {
    status: "available",
    configured: true,
    message: "Directory scanner available",
  };
}

module.exports = {
  key: KEY,
  registerRoutes,
  getHealth,
};
