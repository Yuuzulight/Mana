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

function makeApp(store, extraContext = {}) {
  const app = express();
  app.use(express.json());
  jobApplicationsPlugin.registerRoutes(app, {
    jobApplicationsStore: store,
    ...extraContext,
  });
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

test("POST /jobs/match tailors a resume/cover letter and stages a ready_to_apply application", async () => {
  const store = createJobApplicationsStore({ dataDir: tempDir() });
  store.saveAnswer({ key: "resume", content: "5 years of frontend experience." });

  let receivedPrompt = null;
  const synthesizeJobMatch = async (prompt) => {
    receivedPrompt = prompt;
    return [
      "COMPANY: Acme Corp",
      "ROLE: Frontend Engineer",
      "FIT: Strong match on React experience.",
      "RESUME:",
      "Tailored resume body.",
      "COVER LETTER:",
      "Dear hiring manager,\nTailored cover letter body.",
    ].join("\n");
  };
  const app = makeApp(store, { synthesizeJobMatch });

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/jobs/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postingText: "We are hiring a Frontend Engineer at Acme Corp." }),
    });
    assert.equal(res.status, 201);
    const application = await res.json();
    assert.equal(application.company, "Acme Corp");
    assert.equal(application.role, "Frontend Engineer");
    assert.equal(application.status, "ready_to_apply");
    assert.equal(application.fitSummary, "Strong match on React experience.");
    assert.equal(application.tailoredResume, "Tailored resume body.");
    assert.equal(
      application.tailoredCoverLetter,
      "Dear hiring manager,\nTailored cover letter body.",
    );
    assert.match(receivedPrompt, /5 years of frontend experience\./);
  });
});

test("POST /jobs/match returns 503 when no local model reply function is configured", async () => {
  const store = createJobApplicationsStore({ dataDir: tempDir() });
  const app = makeApp(store);

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/jobs/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postingText: "We are hiring..." }),
    });
    assert.equal(res.status, 503);
  });
});

test("POST /jobs/match rejects a missing postingText", async () => {
  const store = createJobApplicationsStore({ dataDir: tempDir() });
  const app = makeApp(store, { synthesizeJobMatch: async () => "" });

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/jobs/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});

test("buildJobMatchPrompt includes the posting and saved answers, or a fallback note when none are saved", () => {
  const withAnswers = jobApplicationsPlugin.buildJobMatchPrompt("Job posting text", [
    { label: "Resume", content: "background content" },
  ]);
  assert.match(withAnswers, /Job posting text/);
  assert.match(withAnswers, /Resume:\nbackground content/);

  const withoutAnswers = jobApplicationsPlugin.buildJobMatchPrompt("Job posting text", []);
  assert.match(withoutAnswers, /no saved background material/);
});

test("parseJobMatchResponse splits a delimited reply into sections", () => {
  const parsed = jobApplicationsPlugin.parseJobMatchResponse(
    [
      "COMPANY: Acme",
      "ROLE: Engineer",
      "FIT: Good match.",
      "RESUME:",
      "Line one",
      "Line two",
      "COVER LETTER:",
      "Dear hiring manager,",
      "Sincerely, me",
    ].join("\n"),
  );
  assert.deepEqual(parsed, {
    company: "Acme",
    role: "Engineer",
    fit: "Good match.",
    resume: "Line one\nLine two",
    coverLetter: "Dear hiring manager,\nSincerely, me",
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

test("contributePromptContext requires a whole-word match, not a substring inside another word", async () => {
  const store = createJobApplicationsStore({ dataDir: tempDir() });
  store.saveAnswer({ key: "go", label: "Go", content: "golang answer content" });

  const result = await jobApplicationsPlugin.contributePromptContext(
    "how is my job search going?",
    { jobApplicationsStore: store },
  );
  assert.doesNotMatch(result, /golang answer content/);
});

test("contributePromptContext caps tracked applications shown and truncates long notes", async () => {
  const store = createJobApplicationsStore({ dataDir: tempDir() });
  for (let i = 0; i < 12; i += 1) {
    store.createApplication({ company: `Company${i}`, role: "Engineer", appliedAt: `2026-01-${String(i + 1).padStart(2, "0")}` });
  }
  store.createApplication({
    company: "Verbose Co",
    role: "Engineer",
    notes: "x".repeat(500),
    appliedAt: "2026-02-01",
  });

  const result = await jobApplicationsPlugin.contributePromptContext(
    "what's the status of my job applications?",
    { jobApplicationsStore: store },
  );

  const shownCompanies = [...result.matchAll(/^- (\S+)/gm)].map((m) => m[1]);
  assert.equal(shownCompanies.length, 10);
  assert.match(result, /\.\.\.and 3 more\./);
  assert.match(result, /x{200}\.\.\./);
  assert.doesNotMatch(result, /x{201}/);
});
