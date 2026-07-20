const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
// This plugin always runs hosted inside node-bot's Express app in
// production (it never requires express itself -- node-bot hands it an
// already-built `app`); reaching back for express here only for the test's
// own throwaway app avoids vendoring a second copy of it just for tests.
const express = require("../../../node-bot/node_modules/express");
const test = require("node:test");

const jobApplicationsPlugin = require("../index");
const { createJobApplicationsStore } = require("../job-applications-store");
const { withServer } = require("./helpers");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-job-applications-capability-test-"));
}

function makeApp(store) {
  const app = express();
  app.use(express.json());
  jobApplicationsPlugin.registerRoutes(app, { jobApplicationsStore: store });
  return app;
}

test("declares discoverable plugin metadata", () => {
  assert.equal(jobApplicationsPlugin.key, "jobApplications");
  assert.equal(jobApplicationsPlugin.category, "Job Search");
  assert.equal(typeof jobApplicationsPlugin.name, "string");
  assert.equal(typeof jobApplicationsPlugin.description, "string");
});

test("POST /jobs/applications creates and GET /jobs/applications lists it", async () => {
  const store = createJobApplicationsStore({ dataDir: tempDir() });
  const app = makeApp(store);

  await withServer(app, async (baseUrl) => {
    const createRes = await fetch(`${baseUrl}/jobs/applications`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company: "Acme", role: "Engineer" }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.equal(created.company, "Acme");
    assert.equal(created.status, "applied");

    const listRes = await fetch(`${baseUrl}/jobs/applications`);
    const { applications } = await listRes.json();
    assert.equal(applications.length, 1);
    assert.equal(applications[0].id, created.id);
  });
});

test("POST /jobs/applications rejects a missing role with a validation error", async () => {
  const store = createJobApplicationsStore({ dataDir: tempDir() });
  const app = makeApp(store);

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/jobs/applications`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company: "Acme" }),
    });
    assert.equal(res.status, 400);
  });
});

test("PATCH and DELETE /jobs/applications/:id update and remove", async () => {
  const store = createJobApplicationsStore({ dataDir: tempDir() });
  const app = makeApp(store);
  const created = store.createApplication({ company: "Acme", role: "Engineer" });

  await withServer(app, async (baseUrl) => {
    const patchRes = await fetch(`${baseUrl}/jobs/applications/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "offer" }),
    });
    assert.equal(patchRes.status, 200);
    assert.equal((await patchRes.json()).status, "offer");

    const deleteRes = await fetch(`${baseUrl}/jobs/applications/${created.id}`, {
      method: "DELETE",
    });
    assert.equal(deleteRes.status, 200);

    const missingRes = await fetch(`${baseUrl}/jobs/applications/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "offer" }),
    });
    assert.equal(missingRes.status, 404);
  });
});

test("POST /jobs/answers upserts by key and GET /jobs/answers/:key fetches it", async () => {
  const store = createJobApplicationsStore({ dataDir: tempDir() });
  const app = makeApp(store);

  await withServer(app, async (baseUrl) => {
    const saveRes = await fetch(`${baseUrl}/jobs/answers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "ai-experience", content: "draft content" }),
    });
    assert.equal(saveRes.status, 201);

    const getRes = await fetch(`${baseUrl}/jobs/answers/ai-experience`);
    assert.equal(getRes.status, 200);
    assert.equal((await getRes.json()).content, "draft content");

    const missingRes = await fetch(`${baseUrl}/jobs/answers/does-not-exist`);
    assert.equal(missingRes.status, 404);
  });
});

test("contributes market-style prompt context: self-guards on irrelevant text", async () => {
  const store = createJobApplicationsStore({ dataDir: tempDir() });
  store.createApplication({ company: "Acme", role: "Engineer", status: "interviewing" });

  const result = await jobApplicationsPlugin.contributePromptContext(
    "what's the weather today",
    { jobApplicationsStore: store },
  );
  assert.equal(result, "");
});

test("contributePromptContext summarizes tracked applications for a job-shaped question", async () => {
  const store = createJobApplicationsStore({ dataDir: tempDir() });
  store.createApplication({ company: "Acme", role: "Engineer", status: "interviewing" });
  store.createApplication({ company: "Globex", role: "Designer", status: "applied" });

  const result = await jobApplicationsPlugin.contributePromptContext(
    "what's the status of my job applications?",
    { jobApplicationsStore: store },
  );
  assert.match(result, /Acme \(Engineer\): interviewing/);
  assert.match(result, /Globex \(Designer\): applied/);
});

test("contributePromptContext only includes a saved answer the message actually mentions", async () => {
  const store = createJobApplicationsStore({ dataDir: tempDir() });
  store.saveAnswer({ key: "ai-experience", label: "AI experience", content: "my real answer" });
  store.saveAnswer({ key: "leadership", label: "Leadership", content: "unrelated answer" });

  const result = await jobApplicationsPlugin.contributePromptContext(
    "can you give me my AI experience answer for this job application?",
    { jobApplicationsStore: store },
  );
  assert.match(result, /my real answer/);
  assert.doesNotMatch(result, /unrelated answer/);
});
