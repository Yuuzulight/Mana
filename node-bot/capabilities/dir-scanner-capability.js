const path = require('path');
const { scanDir } = require('../tools/dir_scanner');

const KEY = 'dirScanner';

function registerRoutes(app, context = {}) {
  const repoRoot = (context && context.REPO_ROOT) || process.env.REPO_ROOT || path.resolve(__dirname, '..', '..');

  app.get('/tools/dir-scan', (req, res) => {
    try {
      const reqPath = typeof req.query.path === 'string' && req.query.path.trim() ? req.query.path.trim() : '.';
      // Resolve and sandbox to repoRoot
      let resolved = reqPath;
      if (!path.isAbsolute(reqPath)) {
        resolved = path.resolve(repoRoot, reqPath);
      }
      const rel = path.relative(repoRoot, resolved);
      if (rel.startsWith('..')) {
        return res.status(400).json({ ok: false, error: 'path_outside_repo' });
      }

      const maxDepth = Number(req.query.maxDepth || 10);
      const exts = typeof req.query.ext === 'string' && req.query.ext.trim() ? req.query.ext.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean) : null;
      const exclude = typeof req.query.exclude === 'string' && req.query.exclude.trim() ? req.query.exclude.split(',').map(s=>s.trim()).filter(Boolean) : [];

      const list = scanDir(resolved, { path: resolved, maxDepth, exts, exclude });
      return res.json({ ok: true, files: list });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });
}

function getHealth() {
  return { status: 'available', configured: true, message: 'Directory scanner available' };
}

module.exports = {
  key: KEY,
  registerRoutes,
  getHealth,
};
