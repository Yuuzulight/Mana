// /admin/accounts routes (create/list/revoke API-key accounts), moved out
// of server.js's registerRoutes() (#500). Behaviour is unchanged.
const { ADMIN_KEY_REQUIRED_ERROR, hasAdminKey, hasLauncherKey } = require("./admin-key");
const { isLocalRestartRequest } = require("./server-routes");

function registerAdminAccountsRoutes(app, deps) {
  const { authMiddleware, authStore } = deps;

  // Admin-only middleware for account create/revoke (must run after
  // authMiddleware, which sets req.user). Account management is more
  // sensitive than the read-only /api/memory routes -- which are
  // intentionally remote-accessible by design, per issue #93 -- so it gets
  // an extra layer beyond just "the API key has role=admin": ADMIN_TOKEN,
  // or the native launcher's per-run key from this PC (#670, admin-key.js),
  // so a leaked admin API key alone isn't enough to manage accounts.
  function requireAdmin(req, res, next) {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin role required" });
    }
    if (hasAdminKey(req, { local: isLocalRestartRequest(req) })) {
      return next();
    }
    return res.status(403).json({ error: ADMIN_KEY_REQUIRED_ERROR });
  }

  // #1428: the launcher's per-run key, from this PC, is enough on its own --
  // the same trust it gets for restarts and mobile devices. Anyone else
  // needs an admin-role API key plus an admin key, as above.
  function adminAuth(req, res, next) {
    if (hasLauncherKey(req)) {
      req.user = { userId: "launcher", role: "admin" };
      return next();
    }
    return authMiddleware(req, res, () => requireAdmin(req, res, next));
  }

  // Admin only: POST /admin/accounts — create a new account
  app.post("/admin/accounts", adminAuth, (req, res) => {
    try {
      const { email, role = "user" } = req.body;
      if (!email) {
        return res.status(400).json({ error: "email is required" });
      }
      const result = authStore.createAccount({ email, role });
      res.status(201).json({
        userId: result.userId,
        email: result.email,
        role: result.role,
        apiKey: result.apiKey,
        message: "Save your API key somewhere safe; it will not be shown again",
      });
    } catch (e) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  // Admin only: GET /admin/accounts — list all accounts
  app.get("/admin/accounts", adminAuth, (req, res) => {
    try {
      const accounts = authStore.listAccounts();
      res.json(accounts);
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Admin only: DELETE /admin/accounts/:userId — revoke an account
  app.delete("/admin/accounts/:userId", adminAuth, (req, res) => {
    try {
      authStore.deleteAccount(req.params.userId);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });
}

module.exports = { registerAdminAccountsRoutes };
