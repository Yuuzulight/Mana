const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");
const { isPublicRoute } = require("../admin-key");
const { createRequestGuard } = require("../request-guard");
const { withServer } = require("./helpers");

// Every route express has registered, as [METHOD, path], mounted routers
// included (their prefix is only kept as a regexp, e.g. /^\/mobile\/?(?=\/|$)/i).
function registeredRoutes(app) {
  const routes = [];
  const prefixOf = (layer) =>
    layer.regexp.source.split("\\/").join("/").replace(/^\^/, "").replace(/\/\?\(\?=\/\|\$\)$/, "");
  (function walk(stack, prefix) {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          for (const path of [].concat(layer.route.path)) routes.push([method.toUpperCase(), prefix + path]);
        }
      } else if (layer.name === "router") {
        walk(layer.handle.stack, prefix + prefixOf(layer));
      }
    }
  })(app._router.stack, "");
  return routes;
}

test("every route that isn't on the public list answers 401 without an admin key", async () => {
  const app = createApp();
  const routes = registeredRoutes(app);
  assert.ok(routes.length > 200, `found only ${routes.length} routes`);

  const open = [];
  await withServer(app, async (baseUrl) => {
    for (const [method, path] of routes) {
      if (isPublicRoute(method, path)) continue;
      const url = baseUrl + path.replace(/:\w+/g, "x");
      const response = await fetch(url, { method });
      await response.arrayBuffer();
      if (response.status !== 401) open.push(`${method} ${path} -> ${response.status}`);
    }
  });
  assert.deepEqual(open, []);
});

test("the public list is exact routes: no real route rides on a static-folder prefix", () => {
  const riding = registeredRoutes(createApp())
    .filter(([method, path]) => /^\/(mobile\/app|admin\/mobile-devices)\//.test(path) && isPublicRoute(method, path))
    .map(([method, path]) => `${method} ${path}`);
  assert.deepEqual(riding, []);
});

test("the admin key opens a route; public routes need none", async () => {
  const prior = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = "test-admin-token";
  try {
    await withServer(createApp(), async (baseUrl) => {
      assert.equal((await fetch(`${baseUrl}/characters`)).status, 401);
      assert.equal((await fetch(`${baseUrl}/characters`, { headers: { "x-admin-token": "wrong" } })).status, 401);
      assert.equal((await fetch(`${baseUrl}/characters`, { headers: { "x-admin-token": "test-admin-token" } })).status, 200);
      assert.equal((await fetch(`${baseUrl}/characters`, { headers: { Authorization: "Bearer test-admin-token" } })).status, 200);
      assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
      assert.equal((await fetch(`${baseUrl}/mobile/health`)).status, 200);
    });
  } finally {
    if (prior === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = prior;
  }
});

test("WebSocket upgrades need the key, as a header or ?key=", () => {
  const guard = createRequestGuard({ ADMIN_TOKEN: "ws-token" });
  const upgrade = (url, headers = {}) => {
    let written = "";
    const rejected = guard.rejectUpgrade(
      { url, method: "GET", headers: { host: "127.0.0.1:5005", ...headers }, socket: { remoteAddress: "127.0.0.1" } },
      { end: (text) => (written = text) },
    );
    return rejected ? written.split("\r\n")[0] : "accepted";
  };
  assert.equal(upgrade("/ws/tray"), "HTTP/1.1 401 Unauthorized");
  assert.equal(upgrade("/ws/tray?key=wrong"), "HTTP/1.1 401 Unauthorized");
  assert.equal(upgrade("/ws/tray", { "x-admin-token": "ws-token" }), "accepted");
  assert.equal(upgrade("/ws/vision-capture?camera=1&key=ws-token"), "accepted");
  // The Origin check still comes first.
  assert.equal(upgrade("/ws/captions?key=ws-token", { origin: "https://evil.example" }), "HTTP/1.1 403 Forbidden");
});
