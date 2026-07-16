const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");
const { withServer } = require("./helpers");

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    response,
    body: text ? JSON.parse(text) : null,
  };
}

test("admin endpoints require ADMIN_TOKEN when configured", async () => {
  // Configure ADMIN_TOKEN for the process so registerMobileRoutes will pick it up
  const prior = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = "test-admin-token";

  const app = createApp();

  await withServer(app, async (baseUrl) => {
    // Without Authorization header -> expect 401
    const r1 = await fetch(`${baseUrl}/mobile/devices`);
    assert.equal(r1.status, 401);
    const text1 = await r1.text();
    assert.match(text1 || '', /admin_auth_required|admin-only/);

    // With wrong token -> 401
    const r2 = await fetch(`${baseUrl}/mobile/devices`, { headers: { Authorization: 'Bearer bad' } });
    assert.equal(r2.status, 401);

    // With correct token -> 200
    const r3 = await fetch(`${baseUrl}/mobile/devices`, { headers: { Authorization: 'Bearer test-admin-token' } });
    assert.equal(r3.status, 200);
    const j = await r3.json();
    assert.ok(Array.isArray(j.devices));

    // pair/request should also require token and succeed with token
    const p1 = await fetch(`${baseUrl}/mobile/pair/request`, { method: 'POST' });
    assert.equal(p1.status, 401);
    const p2 = await fetch(`${baseUrl}/mobile/pair/request`, { method: 'POST', headers: { Authorization: 'Bearer test-admin-token' } });
    // deviceStore may be configured and return 200 or 500 if not configured, but should not be 401
    assert.notEqual(p2.status, 401);
  });

  // restore
  if (prior === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = prior;
});
