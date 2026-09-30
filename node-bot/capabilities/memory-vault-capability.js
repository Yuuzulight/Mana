// #935: the Obsidian vault sync's status (path, watching/polling, last
// sync, skipped notes -- memory-vault.js getStatus()) and a "Sync now" for
// Settings. { vaultDir: null } when MANA_VAULT_DIR isn't set.
const rateLimit = require("express-rate-limit");

const KEY = "memoryVault";

// Route-local limiter for the same reason as memory-facts-capability.js:
// CodeQL can't see the app-wide one through registerRoutes.
const vaultRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.MANA_RATE_LIMIT_MAX || 300),
  standardHeaders: true,
  legacyHeaders: false,
});

function registerMemoryVaultRoutes(app, context = {}) {
  const checkAdminAuth = context.checkAdminAuth;
  const getMemoryVault = context.getMemoryVault || (() => null);

  app.get("/admin/memory/vault", vaultRateLimiter, (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    const vault = getMemoryVault();
    return res.json(vault ? vault.getStatus() : { vaultDir: null });
  });

  // Also restarts a watcher that died (sync() does).
  app.post("/admin/memory/vault/sync", vaultRateLimiter, (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    const vault = getMemoryVault();
    if (!vault) return res.status(409).json({ error: "Vault sync is off. Set MANA_VAULT_DIR in node-bot/.env." });
    vault.sync();
    vault.refreshViews();
    return res.json(vault.getStatus());
  });
}

const memoryVaultCapability = {
  key: KEY,
  registerRoutes: registerMemoryVaultRoutes,
};

module.exports = { registerMemoryVaultRoutes, memoryVaultCapability };
