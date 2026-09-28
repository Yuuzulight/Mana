// Issue #670: Host (DNS rebinding) + Origin (CSRF) guard.
const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const WebSocket = require("ws");

const { createRequestGuard } = require("../request-guard");
const { createApp } = require("../server");
const { registerVisionCaptureServer } = require("../vision-capture-server");
const { withServer } = require("./helpers");

function fakeReq(headers, method = "POST", path = "/reply") {
  return { headers, method, path };
}

test("Host check allows loopback, IP literals and configured hosts only", () => {
  const guard = createRequestGuard({
    MANA_ALLOWED_HOSTS: "Mana.Example.com, other.test",
    MANA_TUNNEL_URL: "https://tunnel.example.org/mobile/app/",
  });
  const allowed = [
    "127.0.0.1:5005",
    "localhost:5005",
    "LOCALHOST:5005",
    "localhost.:5005",
    "[::1]:5005",
    "[::1]",
    "192.168.1.50:5005",
    "[::ffff:127.0.0.1]:5005",
    "mana.example.com",
    "other.test:443",
    "tunnel.example.org",
  ];
  for (const host of allowed) {
    assert.equal(guard.isAllowedHost(fakeReq({ host })), true, host);
  }
  const blocked = [
    "evil.com",
    "evil.com:5005",
    "localhost.evil.com:5005",
    "127.0.0.1.evil.com:5005",
    "[::1].evil.com",
    "mana.example.com.evil.com",
    "",
  ];
  for (const host of blocked) {
    assert.equal(guard.isAllowedHost(fakeReq({ host })), false, host);
  }
  // Browsers always send Host; a raw client leaving it out isn't rebinding.
  assert.equal(guard.isAllowedHost(fakeReq({})), true);
});

test("Origin check allows same-origin, file://, extensions and configured origins only", () => {
  const guard = createRequestGuard({ MANA_ALLOWED_ORIGINS: "app://obsidian.md" });
  const host = "127.0.0.1:5005";
  const allowed = [
    undefined,
    "http://127.0.0.1:5005",
    "HTTP://127.0.0.1:5005",
    "file://",
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    "moz-extension://0b5d3f4e-1c2a-4e8b-9a7d-2f6c1e0b9a11",
    "app://obsidian.md",
  ];
  for (const origin of allowed) {
    assert.equal(guard.isAllowedOrigin(fakeReq({ host, origin })), true, String(origin));
  }
  const blocked = [
    "null",
    "http://evil.com",
    "http://127.0.0.1:3000",
    "http://localhost:5005", // a different origin than 127.0.0.1:5005
    "http://127.0.0.1:5005.evil.com",
    "https://evil.com/?http://127.0.0.1:5005",
    "chrome-extension://abc/../evil",
    "file:///C:/Users/evil.html",
    "http://127.0.0.1:5005, http://evil.com",
    "",
  ];
  for (const origin of blocked) {
    assert.equal(guard.isAllowedOrigin(fakeReq({ host, origin })), false, origin);
  }
  // Same-origin through a tunnel hostname.
  assert.equal(
    guard.isAllowedOrigin(
      fakeReq({ host: "mana.example.com", origin: "https://mana.example.com" }),
    ),
    true,
  );
});

function rawRequest(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers, agent: false },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("app rejects cross-site and rebinding requests but keeps its own clients working", async () => {
  let replies = 0;
  const app = createApp({
    buildAssistantReply: async () => {
      replies += 1;
      return "hi";
    },
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await withServer(app, async (baseUrl) => {
      const port = Number(new URL(baseUrl).port);
      const json = { "Content-Type": "application/json" };
      const body = JSON.stringify({ text: "hello" });

      // Browser page on another site: blocked before the route runs.
      const evil = await rawRequest(port, {
        method: "POST",
        path: "/reply",
        headers: { ...json, Origin: "http://evil.com" },
        body,
      });
      assert.equal(evil.status, 403);
      assert.match(evil.body, /Origin/);

      // Form-style simple request (no preflight) is blocked too.
      const form = await rawRequest(port, {
        method: "POST",
        path: "/reply",
        headers: { "Content-Type": "text/plain", Origin: "null" },
        body: "x",
      });
      assert.equal(form.status, 403);

      // DNS rebinding: attacker hostname in Host, even with no Origin and on GET.
      const rebound = await rawRequest(port, {
        path: "/health",
        headers: { Host: `evil.com:${port}` },
      });
      assert.equal(rebound.status, 403);
      assert.match(rebound.body, /Host/);
      assert.equal(replies, 0);

      // Native launcher / Node clients: no Origin.
      const native = await rawRequest(port, { method: "POST", path: "/reply", headers: json, body });
      assert.equal(native.status, 200);
      // Electron renderer (file://) and a same-origin page.
      for (const origin of ["file://", `http://127.0.0.1:${port}`]) {
        const res = await rawRequest(port, {
          method: "POST",
          path: "/reply",
          headers: { ...json, Origin: origin },
          body,
        });
        assert.equal(res.status, 200, origin);
        assert.equal(res.headers["access-control-allow-origin"], origin);
      }
      assert.equal(replies, 3);

      // API-key routes stay callable from other origins (Obsidian); the key
      // check still applies.
      const obsidian = await rawRequest(port, {
        method: "POST",
        path: "/v1/chat/completions",
        headers: { ...json, Origin: "app://obsidian.md" },
        body: "{}",
      });
      assert.equal(obsidian.status, 401);

      // CORS preflight: no allow-origin for a foreign page.
      const preflight = await rawRequest(port, {
        method: "OPTIONS",
        path: "/reply",
        headers: {
          Origin: "http://evil.com",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      });
      assert.equal(preflight.headers["access-control-allow-origin"], undefined);
    });
  } finally {
    console.warn = originalWarn;
  }
});

test("WebSocket upgrades from a foreign origin or rebinding host are refused", async (t) => {
  const server = http.createServer();
  registerVisionCaptureServer(server, {
    bridge: { setSender() {} },
    requestGuard: createRequestGuard({}),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `ws://127.0.0.1:${server.address().port}/ws/vision-capture`;

  const connect = (options) =>
    new Promise((resolve) => {
      const ws = new WebSocket(url, options);
      ws.once("open", () => {
        ws.close();
        resolve("open");
      });
      ws.once("unexpected-response", (req, res) => resolve(res.statusCode));
      ws.once("error", () => resolve("error"));
    });

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await connect({}), "open");
    assert.equal(await connect({ origin: "file://" }), "open");
    assert.equal(await connect({ origin: "http://evil.com" }), 403);
    assert.equal(await connect({ headers: { Host: "evil.com" } }), 403);
  } finally {
    console.warn = originalWarn;
  }
});
