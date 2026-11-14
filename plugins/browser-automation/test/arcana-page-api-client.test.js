const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { ArcanaPageApiClient, ArcanaPageApiError } = require("../arcana-page-api-client");

async function withApiServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/`;
  try { await fn(endpoint); }
  finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}

function json(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : null;
}

test("Arcana API client accepts only an authenticated loopback endpoint", async () => {
  assert.throws(() => new ArcanaPageApiClient({ endpoint: "https://127.0.0.1:5000", token: "secret" }), /HTTP on loopback/);
  assert.throws(() => new ArcanaPageApiClient({ endpoint: "http://example.com:5000", token: "secret" }), /HTTP on loopback/);
  assert.throws(() => new ArcanaPageApiClient({ endpoint: "http://127.0.0.1:5000/v1", token: "secret" }), /HTTP on loopback/);
  assert.throws(() => new ArcanaPageApiClient({ endpoint: "http://127.0.0.1:5000", token: "" }), /bearer token is required/);
  const controller = new AbortController();
  controller.abort();
  const aborted = new ArcanaPageApiClient({
    endpoint: "http://127.0.0.1:5000/",
    token: "secret",
    fetchImpl: async (_url, { signal }) => {
      assert.equal(signal.aborted, true);
      throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    },
  });
  await assert.rejects(aborted.health({ signal: controller.signal }), (error) => error.code === "aborted");
  assert.throws(() => aborted.pageRoute("page-1", "../health"), /action is invalid/);
});

test("Arcana API client authenticates v1 calls and maps page operations and screenshots", async () => {
  const seen = [];
  const server = async (request, response) => {
    if (request.headers.authorization !== "Bearer test-token") return json(response, 401, { error: { code: "unauthorized", message: "bad token" } });
    const body = await readBody(request);
    seen.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body });
    if (request.url === "/v1/health") return json(response, 200, { apiVersion: "v1", engine: { backend: "obscura" } });
    if (request.url === "/v1/pages" && request.method === "POST") return json(response, 201, { pageId: "page-1", url: body.url });
    if (request.url === "/v1/pages/page-1/navigate") return json(response, 200, { ok: true });
    if (request.url === "/v1/pages/page-1/fill") return json(response, 200, { ok: true });
    if (request.url === "/v1/pages/page-1/click-at") return json(response, 200, { ok: true });
    if (request.url === "/v1/pages/page-1/snapshot") return json(response, 200, { url: "https://example.test/", text: "ready", controls: [] });
    if (request.url === "/v1/pages/page-1/screenshot?format=jpeg&quality=50") {
      response.writeHead(200, { "Content-Type": "image/jpeg" });
      return response.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }
    if (request.url === "/v1/pages/page-1/stale") return json(response, 409, { error: { code: "stale_reference", message: "snapshot is out of date" } });
    if (request.method === "DELETE" && request.url === "/v1/pages/page-1") { response.writeHead(204); return response.end(); }
    return json(response, 404, { error: { code: "not_found", message: "missing route" } });
  };

  await withApiServer(server, async (endpoint) => {
    const client = new ArcanaPageApiClient({ endpoint, token: "test-token" });
    await assert.rejects(client.request("GET", "https://example.com/v1/health"), /stay on the authenticated v1 loopback endpoint/);
    assert.equal((await client.health()).engine.backend, "obscura");
    assert.deepEqual(await client.createPage("https://example.test/"), { pageId: "page-1", url: "https://example.test/" });
    await client.navigate("page-1", "https://example.test/next");
    await client.fill("page-1", "e1", "value");
    await client.clickAt("page-1", 12, 34);
    assert.deepEqual(await client.snapshot("page-1"), { url: "https://example.test/", text: "ready", controls: [] });
    assert.deepEqual(await client.screenshot("page-1", { format: "jpeg", quality: 50 }), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    await assert.rejects(client.pageAction("page-1", "stale", {}), (error) => {
      assert.ok(error instanceof ArcanaPageApiError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "stale_reference");
      return true;
    });
    assert.equal(await client.closePage("page-1"), null);

    assert.ok(seen.every((call) => call.authorization === "Bearer test-token"));
    assert.deepEqual(seen.find((call) => call.method === "POST" && call.path === "/v1/pages").body, { url: "https://example.test/" });
    assert.equal(seen.find((call) => call.path === "/v1/pages/page-1/fill").body.ref, "e1");
    assert.deepEqual(seen.find((call) => call.path === "/v1/pages/page-1/click-at").body, { x: 12, y: 34 });
  });
});

test("Arcana API client rejects incompatible versions and reports auth errors", async () => {
  await withApiServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer right") return json(response, 401, { error: { code: "unauthorized", message: "bad token" } });
    return json(response, 200, { apiVersion: "v2" });
  }, async (endpoint) => {
    const wrongVersion = new ArcanaPageApiClient({ endpoint, token: "right" });
    await assert.rejects(wrongVersion.health(), (error) => error.code === "api_version_mismatch");
    const wrongToken = new ArcanaPageApiClient({ endpoint, token: "wrong" });
    await assert.rejects(wrongToken.health(), (error) => error.status === 401 && error.code === "unauthorized");
  });
});
