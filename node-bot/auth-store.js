// Multi-account authentication: admin/developer account + basic user accounts
// with API key authorization. Accounts stored locally in accounts.json.
// Admin account auto-created on first startup; other accounts require admin action.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function createAuthStore(options = {}) {
  const dataDir =
    options.dataDir ||
    process.env.MANA_AUTH_DIR ||
    path.join(__dirname, "data");
  const filePath = path.join(dataDir, "auth", "accounts.json");
  const makeKey = options.makeKey || (() => crypto.randomBytes(32).toString("hex"));
  const hashKey = options.hashKey || ((key) => {
    return crypto.createHash("sha256").update(key).digest("hex");
  });

  function ensureDir() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  function readAll() {
    ensureDir();
    if (!fs.existsSync(filePath)) {
      return [];
    }
    try {
      const raw = fs.readFileSync(filePath, "utf8").trim();
      if (!raw) {
        return [];
      }
      return JSON.parse(raw) || [];
    } catch (e) {
      console.warn("Failed to read accounts:", e?.message || e);
      return [];
    }
  }

  function writeAll(accounts) {
    ensureDir();
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(accounts, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, filePath);
  }

  // Returns { userId, role, email, createdAt }; never returns key hash
  function getAccountByUserId(userId) {
    if (!userId) return null;
    const accounts = readAll();
    const account = accounts.find((a) => a.userId === userId);
    return account ? { ...account, keyHash: undefined } : null;
  }

  // Returns null if key invalid; { userId, role } if valid
  function validateKey(rawKey) {
    if (!rawKey || typeof rawKey !== "string") return null;
    const accounts = readAll();
    const hashedKey = hashKey(rawKey);
    const account = accounts.find((a) => a.keyHash === hashedKey);
    return account ? { userId: account.userId, role: account.role } : null;
  }

  function createAccount({ email, role = "user" }) {
    if (!email || typeof email !== "string") {
      throw new Error("email is required");
    }
    if (!["admin", "user"].includes(role)) {
      throw new Error("role must be 'admin' or 'user'");
    }

    const accounts = readAll();
    if (accounts.find((a) => a.email === email)) {
      throw new Error(`account ${email} already exists`);
    }

    const userId = crypto.randomUUID();
    const rawKey = makeKey();
    const keyHash = hashKey(rawKey);

    const account = {
      userId,
      email,
      role,
      keyHash,
      createdAt: new Date().toISOString(),
    };

    accounts.push(account);
    writeAll(accounts);

    return {
      userId,
      email,
      role,
      apiKey: rawKey, // only returned once; user must save it
    };
  }

  // Only used during first startup: create the admin account for this machine
  function ensureAdminAccount() {
    const accounts = readAll();
    const admin = accounts.find((a) => a.role === "admin");

    if (admin) {
      return { userId: admin.userId, email: admin.email, alreadyExists: true };
    }

    // Generate initial admin key and save it to a setup file the user reads once
    const adminEmail = "admin@localhost";
    const adminResult = createAccount({ email: adminEmail, role: "admin" });

    // Write setup info to a marker file so the user knows their key. This
    // branch only runs when no admin account exists (see the `if (admin)`
    // check above), so any pre-existing SETUP.txt necessarily belongs to a
    // now-gone admin -- always overwrite it with the key we just generated,
    // otherwise a stale file silently swallows the only copy of the new key.
    const setupPath = path.join(path.dirname(filePath), "SETUP.txt");
    fs.writeFileSync(
      setupPath,
      `Mana Admin Setup\n` +
      `================\n\n` +
      `Email: ${adminResult.email}\n` +
      `API Key: ${adminResult.apiKey}\n\n` +
      `Save this key somewhere safe. You'll need it to manage accounts and access the memory API.\n` +
      `After saving, you can delete this file.\n`,
      "utf8"
    );
    console.log(
      `Admin account created. Save your API key from ${setupPath}`
    );

    return {
      userId: adminResult.userId,
      email: adminResult.email,
      alreadyExists: false,
    };
  }

  // Admin only: list all accounts (without key hashes)
  function listAccounts() {
    return readAll().map((a) => ({ ...a, keyHash: undefined }));
  }

  // Admin only: revoke an account by userId
  function deleteAccount(userId) {
    const accounts = readAll();
    const idx = accounts.findIndex((a) => a.userId === userId);
    if (idx === -1) {
      throw new Error(`account ${userId} not found`);
    }
    accounts.splice(idx, 1);
    writeAll(accounts);
    return true;
  }

  return {
    validateKey,
    getAccountByUserId,
    createAccount,
    ensureAdminAccount,
    listAccounts,
    deleteAccount,
  };
}

module.exports = { createAuthStore };
