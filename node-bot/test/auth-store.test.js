const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { createAuthStore } = require("../auth-store");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-auth-test-"));
}

test("auth-store: create account and validate key", async (t) => {
  const tempDir = createTempDir();
  try {
    const authStore = createAuthStore({ dataDir: tempDir });

    const result = authStore.createAccount({ email: "user@test.com", role: "user" });
    assert.ok(result.userId);
    assert.equal(result.email, "user@test.com");
    assert.equal(result.role, "user");
    assert.ok(result.apiKey);

    const validated = authStore.validateKey(result.apiKey);
    assert.ok(validated);
    assert.equal(validated.userId, result.userId);
    assert.equal(validated.role, "user");
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test("auth-store: invalid key returns null", async (t) => {
  const tempDir = createTempDir();
  try {
    const authStore = createAuthStore({ dataDir: tempDir });
    authStore.createAccount({ email: "user@test.com" });

    const validated = authStore.validateKey("invalid-key-xxx");
    assert.strictEqual(validated, null);
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test("auth-store: admin account created on first startup", async (t) => {
  const tempDir = createTempDir();
  try {
    const authStore = createAuthStore({ dataDir: tempDir });

    const result = authStore.ensureAdminAccount();
    assert.ok(result.userId);
    assert.ok(result.email.includes("localhost"));
    assert.equal(result.alreadyExists, false);

    // Second call should find existing
    const result2 = authStore.ensureAdminAccount();
    assert.equal(result2.userId, result.userId);
    assert.equal(result2.alreadyExists, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test("auth-store: duplicate email rejected", async (t) => {
  const tempDir = createTempDir();
  try {
    const authStore = createAuthStore({ dataDir: tempDir });
    authStore.createAccount({ email: "user@test.com" });

    assert.throws(
      () => authStore.createAccount({ email: "user@test.com" }),
      /already exists/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test("auth-store: list accounts hides key hashes", async (t) => {
  const tempDir = createTempDir();
  try {
    const authStore = createAuthStore({ dataDir: tempDir });
    const result = authStore.createAccount({ email: "user@test.com" });

    const accounts = authStore.listAccounts();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].email, "user@test.com");
    assert.strictEqual(accounts[0].keyHash, undefined);
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test("auth-store: delete account by userId", async (t) => {
  const tempDir = createTempDir();
  try {
    const authStore = createAuthStore({ dataDir: tempDir });
    const result = authStore.createAccount({ email: "user@test.com" });

    authStore.deleteAccount(result.userId);
    const accounts = authStore.listAccounts();
    assert.equal(accounts.length, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test("auth-store: getAccountByUserId hides key hash", async (t) => {
  const tempDir = createTempDir();
  try {
    const authStore = createAuthStore({ dataDir: tempDir });
    const result = authStore.createAccount({ email: "user@test.com" });

    const account = authStore.getAccountByUserId(result.userId);
    assert.ok(account);
    assert.equal(account.email, "user@test.com");
    assert.strictEqual(account.keyHash, undefined);
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test("auth-store: SETUP.txt written once on admin account creation", async (t) => {
  const tempDir = createTempDir();
  try {
    const authStore = createAuthStore({ dataDir: tempDir });
    authStore.ensureAdminAccount();

    const setupPath = path.join(tempDir, "auth", "SETUP.txt");
    assert.ok(fs.existsSync(setupPath));

    const content = fs.readFileSync(setupPath, "utf8");
    assert.ok(content.includes("Mana Admin Setup"));
    assert.ok(content.includes("API Key:"));
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test("auth-store: SETUP.txt is overwritten with the new admin's key when accounts.json is reset but the old file lingers", async (t) => {
  const tempDir = createTempDir();
  try {
    const authStore = createAuthStore({ dataDir: tempDir });
    const first = authStore.ensureAdminAccount();

    // Simulate accounts.json being wiped/corrupted while the stale
    // SETUP.txt from the first admin is left behind on disk.
    fs.rmSync(path.join(tempDir, "auth", "accounts.json"));

    const second = authStore.ensureAdminAccount();
    assert.notEqual(second.userId, first.userId);

    const setupPath = path.join(tempDir, "auth", "SETUP.txt");
    const content = fs.readFileSync(setupPath, "utf8");
    const match = content.match(/API Key: (\S+)/);
    assert.ok(match, "SETUP.txt must contain the new admin's key, not be skipped because a stale file existed");

    // The key written to SETUP.txt must actually validate as the *new* admin.
    const validated = authStore.validateKey(match[1]);
    assert.ok(validated);
    assert.equal(validated.userId, second.userId);
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});
