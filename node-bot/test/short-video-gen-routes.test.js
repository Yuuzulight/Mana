const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");
const { withServer } = require("./helpers");

// These routes were originally wired inside startServer()'s own
// bolt-onto-app section, where checkAdminAuth (a closure private to
// registerRoutes()) is out of scope -- gating them there would have
// thrown ReferenceError on the first request. Moved into registerRoutes()
// instead, which is also what makes them reachable via createApp() here at
// all.
test("short-video-gen routes require admin auth when MANA_ADMIN_SECRET is set", async () => {
  const app = createApp({ env: { MANA_ADMIN_SECRET: "topsecret" } });

  await withServer(app, async (baseUrl) => {
    const noAuthStatus = await fetch(`${baseUrl}/api/v1/addons/short-video-gen/status/abc`);
    assert.equal(noAuthStatus.status, 401);

    const noAuthConsent = await fetch(`${baseUrl}/api/v1/addons/short-video-gen/consent/abc`, {
      method: "POST",
    });
    assert.equal(noAuthConsent.status, 401);

    const noAuthGenerate = await fetch(`${baseUrl}/api/v1/addons/short-video-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(noAuthGenerate.status, 401);

    const withAuth = await fetch(`${baseUrl}/api/v1/addons/short-video-gen/status/abc`, {
      headers: { Authorization: "Bearer topsecret" },
    });
    assert.equal(withAuth.status, 200);
    const body = await withAuth.json();
    assert.equal(body.id, "abc");
  });
});

test("short-video-gen routes allow requests when no admin secret is configured (local dev)", async () => {
  const app = createApp({ env: {} });

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/addons/short-video-gen/status/abc`);
    assert.equal(res.status, 200);
  });
});
