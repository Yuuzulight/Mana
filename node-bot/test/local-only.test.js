const assert = require("node:assert/strict");
const http = require("node:http");
const https = require("node:https");
const test = require("node:test");

const { assertLocalUrl, installLocalOnlyGuard, isLocalHost } = require("../local-only");
const { searchWeb } = require("../tools/web-access");

test("isLocalHost: this PC and private/link-local IPs only, never a lookalike hostname", () => {
  for (const host of ["localhost", "LOCALHOST.", "127.0.0.1", "[::1]", "::ffff:10.1.2.3", "192.168.1.5", "172.31.0.1", "fd00::1", "fe80::1"]) {
    assert.equal(isLocalHost(host), true, host);
  }
  for (const host of ["", "example.com", "10.evil.com", "localhost.evil.com", "8.8.8.8", "::ffff:8.8.8.8", "172.32.0.1", "2001:db8::1"]) {
    assert.equal(isLocalHost(host), false, host);
  }
});

test("assertLocalUrl does nothing while local-only mode is off", () => {
  assert.doesNotThrow(() => assertLocalUrl("https://api.openai.com", "remote AI at", {}));
});

test("web search refuses in local-only mode (SearXNG is local but searches the internet)", async () => {
  await assert.rejects(searchWeb("weather", { env: { MANA_LOCAL_ONLY: "1" } }), /Local-only mode is on .*web search/);
});

function getError(request) {
  return new Promise((resolve) => {
    request.on("error", resolve).on("response", (res) => {
      res.resume();
      resolve(null);
    });
  });
}

test("the guard blocks every outside connection with an explanation and lets local ones through", async () => {
  installLocalOnlyGuard();

  await assert.rejects(fetch("https://example.com/"), /Local-only mode is on .*example\.com/);
  assert.match((await getError(https.get("https://example.com/"))).message, /Local-only mode is on .*example\.com/);
  assert.match((await getError(http.get("http://8.8.8.8/"))).message, /the connection to 8\.8\.8\.8/);

  const server = http.createServer((req, res) => res.end("local ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "local ok");
    assert.equal(await (await fetch(`http://localhost:${port}/`)).text(), "local ok");
    assert.equal(await getError(http.get(`http://127.0.0.1:${port}/`)), null);
  } finally {
    server.close();
  }
});

test("the launcher's toggle turns local-only mode on too", () => {
  const { isLocalOnly } = require("../local-only");
  assert.equal(isLocalOnly({}), false);
  assert.equal(isLocalOnly({ MANA_LOCAL_ONLY: "1" }), true);
  assert.equal(isLocalOnly({ MANA_LOCAL_ONLY: "0", MANA_LAUNCHER_LOCAL_ONLY: "1" }), true);
});

test("bridges say they're blocked in local-only mode; a LAN Matrix homeserver still works", () => {
  const matrix = { MANA_MATRIX_ACCESS_TOKEN: "t", MANA_MATRIX_USER_ID: "@mana:x" };
  const cases = [
    ["discord-bot", { MANA_DISCORD_BOT_TOKEN: "t" }, /Discord bot's connection to discord\.com/],
    ["telegram-bridge", { MANA_TELEGRAM_BOT_TOKEN: "t" }, /Telegram bridge's connection to api\.telegram\.org/],
    ["matrix-bridge", { ...matrix, MANA_MATRIX_HOMESERVER_URL: "https://matrix.org" }, /Matrix bridge's connection to matrix\.org/],
  ];
  for (const [plugin, env, reason] of cases) {
    const { getHealth } = require(`../../plugins/${plugin}`);
    assert.equal(getHealth({ env }).status, "configured", plugin);
    const blocked = getHealth({ env: { ...env, MANA_LOCAL_ONLY: "1" } });
    assert.equal(blocked.status, "unavailable", plugin);
    assert.match(blocked.message, /^Local-only mode is on/, plugin);
    assert.match(blocked.message, reason, plugin);
  }
  const lan = { ...matrix, MANA_MATRIX_HOMESERVER_URL: "http://192.168.1.5:8008", MANA_LOCAL_ONLY: "1" };
  assert.equal(require("../../plugins/matrix-bridge").getHealth({ env: lan }).status, "configured");
});
