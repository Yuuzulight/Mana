const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DEFAULT_BACKEND_BASE_URL,
  assertValidBackendBaseUrl,
  isLoopbackHostname,
  createBackendConfigStore,
} = require("../backend-config");

function createTempConfigPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mana-backend-config-")), "mana-config.json");
}

test("assertValidBackendBaseUrl accepts http/https and rejects everything else", () => {
  assert.doesNotThrow(() => assertValidBackendBaseUrl("http://192.168.1.50:5005"));
  assert.doesNotThrow(() => assertValidBackendBaseUrl("https://mana.example.com"));
  assert.throws(() => assertValidBackendBaseUrl("not a url"), /invalid backend URL/);
  assert.throws(() => assertValidBackendBaseUrl("ftp://example.com"), /http or https/);
});

test("isLoopbackHostname recognizes localhost/127.0.0.1/::1 and rejects a LAN address", () => {
  assert.equal(isLoopbackHostname("localhost"), true);
  assert.equal(isLoopbackHostname("127.0.0.1"), true);
  assert.equal(isLoopbackHostname("::1"), true);
  assert.equal(isLoopbackHostname("192.168.1.50"), false);
});

test("getBackendBaseUrl defaults to localhost:5005 when no config file exists yet", () => {
  const store = createBackendConfigStore({ configPath: createTempConfigPath() });
  assert.equal(store.getBackendBaseUrl(), DEFAULT_BACKEND_BASE_URL);
  assert.equal(store.isBackendUrlLoopback(), true);
});

test("setBackendBaseUrl persists a new value that getBackendBaseUrl then returns", () => {
  const store = createBackendConfigStore({ configPath: createTempConfigPath() });
  store.setBackendBaseUrl("http://192.168.1.50:5005");
  assert.equal(store.getBackendBaseUrl(), "http://192.168.1.50:5005");
  assert.equal(store.isBackendUrlLoopback(), false);
});

test("setBackendBaseUrl strips a trailing slash", () => {
  const store = createBackendConfigStore({ configPath: createTempConfigPath() });
  store.setBackendBaseUrl("http://192.168.1.50:5005/");
  assert.equal(store.getBackendBaseUrl(), "http://192.168.1.50:5005");
});

test("setBackendBaseUrl rejects an invalid URL and leaves the previous value in place", () => {
  const store = createBackendConfigStore({ configPath: createTempConfigPath() });
  store.setBackendBaseUrl("http://192.168.1.50:5005");
  assert.throws(() => store.setBackendBaseUrl("not a url"));
  assert.equal(store.getBackendBaseUrl(), "http://192.168.1.50:5005");
});

test("a second store instance backed by the same configPath sees the persisted value", () => {
  const configPath = createTempConfigPath();
  createBackendConfigStore({ configPath }).setBackendBaseUrl("https://mana.example.com");
  const reopened = createBackendConfigStore({ configPath });
  assert.equal(reopened.getBackendBaseUrl(), "https://mana.example.com");
});
