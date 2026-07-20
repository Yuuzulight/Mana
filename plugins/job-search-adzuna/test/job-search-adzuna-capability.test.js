const assert = require("node:assert/strict");
// This plugin always runs hosted inside node-bot's Express app in
// production (it never requires express itself -- node-bot hands it an
// already-built `app`); reaching back for express here only for the test's
// own throwaway app avoids vendoring a second copy of it just for tests.
const express = require("../../../node-bot/node_modules/express");
const test = require("node:test");

const jobSearchAdzunaPlugin = require("../index");
const { withServer } = require("./helpers");

function fakeClient({ isConfigured = true, country = "us", searchJobs } = {}) {
  return {
    isConfigured,
    country,
    searchJobs:
      searchJobs ||
      (async () => ({
        count: 1,
        listings: [{ id: "1", title: "Engineer", company: "Acme", location: "Remote" }],
      })),
  };
}

function makeApp(adzunaClient) {
  const app = express();
  app.use(express.json());
  jobSearchAdzunaPlugin.registerRoutes(app, { adzunaClient });
  return app;
}

test("declares discoverable plugin metadata", () => {
  assert.equal(jobSearchAdzunaPlugin.key, "jobSearchAdzuna");
  assert.equal(jobSearchAdzunaPlugin.category, "Job Search");
  assert.equal(typeof jobSearchAdzunaPlugin.name, "string");
  assert.equal(typeof jobSearchAdzunaPlugin.description, "string");
});

test("GET /jobs/search returns normalized listings from the client", async () => {
  let receivedArgs = null;
  const client = fakeClient({
    searchJobs: async (args) => {
      receivedArgs = args;
      return { count: 2, listings: [{ id: "1" }, { id: "2" }] };
    },
  });
  const app = makeApp(client);

  await withServer(app, async (baseUrl) => {
    const res = await fetch(
      `${baseUrl}/jobs/search?what=Frontend%20Engineer&where=Singapore&page=2&resultsPerPage=5`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.source, "Adzuna");
    assert.equal(body.count, 2);
    assert.equal(body.listings.length, 2);

    assert.equal(receivedArgs.what, "Frontend Engineer");
    assert.equal(receivedArgs.where, "Singapore");
    assert.equal(receivedArgs.page, 2);
    assert.equal(receivedArgs.resultsPerPage, 5);
  });
});

test("GET /jobs/search rejects a missing what", async () => {
  const app = makeApp(fakeClient());

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/jobs/search`);
    assert.equal(res.status, 400);
  });
});

test("GET /jobs/search returns 503 when the client is not configured", async () => {
  const app = makeApp(fakeClient({ isConfigured: false }));

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/jobs/search?what=engineer`);
    assert.equal(res.status, 503);
  });
});

test("getHealth reports configured/unconfigured based on the client", () => {
  assert.deepEqual(
    jobSearchAdzunaPlugin.getHealth({ adzunaClient: fakeClient({ country: "sg" }) }),
    {
      status: "configured",
      configured: true,
      message: "Adzuna job search is configured (country: sg).",
    },
  );

  const unconfigured = jobSearchAdzunaPlugin.getHealth({
    adzunaClient: fakeClient({ isConfigured: false }),
  });
  assert.equal(unconfigured.status, "unconfigured");
  assert.equal(unconfigured.configured, false);

  const noClient = jobSearchAdzunaPlugin.getHealth({});
  assert.equal(noClient.status, "unconfigured");
});
