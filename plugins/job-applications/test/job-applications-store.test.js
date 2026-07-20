const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createJobApplicationsStore } = require("../job-applications-store");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-job-applications-test-"));
}

test("starts empty and creates an application with trimmed fields and defaults", () => {
  const store = createJobApplicationsStore({
    dataDir: tempDir(),
    now: () => "2026-01-01T00:00:00.000Z",
    makeId: () => "id-1",
  });

  assert.deepEqual(store.listApplications(), []);

  const application = store.createApplication({
    company: "  Acme Corp  ",
    role: "  Frontend Engineer  ",
  });

  assert.deepEqual(application, {
    id: "id-1",
    company: "Acme Corp",
    role: "Frontend Engineer",
    status: "applied",
    url: "",
    notes: "",
    appliedAt: "2026-01-01T00:00:00.000Z",
    postingText: "",
    fitSummary: "",
    tailoredResume: "",
    tailoredCoverLetter: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(store.getApplication("id-1"), application);
});

test("createApplication rejects a missing company or role", () => {
  const store = createJobApplicationsStore({ dataDir: tempDir() });
  assert.throws(
    () => store.createApplication({ company: "", role: "x" }),
    /company is required/,
  );
  assert.throws(
    () => store.createApplication({ company: "x", role: "" }),
    /role is required/,
  );
});

test("createApplication rejects an invalid status", () => {
  const store = createJobApplicationsStore({ dataDir: tempDir() });
  assert.throws(
    () => store.createApplication({ company: "x", role: "y", status: "ghosted" }),
    /status must be one of/,
  );
});

test("listApplications sorts by appliedAt, most recent first", () => {
  const store = createJobApplicationsStore({ dataDir: tempDir() });
  store.createApplication({ company: "A", role: "r", appliedAt: "2026-01-01" });
  store.createApplication({ company: "B", role: "r", appliedAt: "2026-03-01" });
  store.createApplication({ company: "C", role: "r", appliedAt: "2026-02-01" });

  assert.deepEqual(
    store.listApplications().map((a) => a.company),
    ["B", "C", "A"],
  );
});

test("updateApplication updates individual fields and validates status", () => {
  const store = createJobApplicationsStore({ dataDir: tempDir(), makeId: () => "id-1" });
  store.createApplication({ company: "Acme", role: "Engineer" });

  const updated = store.updateApplication("id-1", { status: "interviewing" });
  assert.equal(updated.status, "interviewing");
  assert.equal(updated.company, "Acme");

  assert.throws(
    () => store.updateApplication("id-1", { status: "nope" }),
    /status must be one of/,
  );
  assert.equal(store.updateApplication("missing", { status: "offer" }), null);
});

test("createApplication accepts ready_to_apply status and job-match fields", () => {
  const store = createJobApplicationsStore({ dataDir: tempDir(), makeId: () => "id-1" });
  const application = store.createApplication({
    company: "Acme",
    role: "Engineer",
    status: "ready_to_apply",
    postingText: "We are hiring a...",
    fitSummary: "Strong match on frontend experience.",
    tailoredResume: "Tailored resume text",
    tailoredCoverLetter: "Tailored cover letter text",
  });

  assert.equal(application.status, "ready_to_apply");
  assert.equal(application.postingText, "We are hiring a...");
  assert.equal(application.fitSummary, "Strong match on frontend experience.");
  assert.equal(application.tailoredResume, "Tailored resume text");
  assert.equal(application.tailoredCoverLetter, "Tailored cover letter text");
});

test("updateApplication updates job-match fields", () => {
  const store = createJobApplicationsStore({ dataDir: tempDir(), makeId: () => "id-1" });
  store.createApplication({ company: "Acme", role: "Engineer", status: "ready_to_apply" });

  const updated = store.updateApplication("id-1", {
    tailoredResume: "Revised resume",
    fitSummary: "Revised fit summary",
  });
  assert.equal(updated.tailoredResume, "Revised resume");
  assert.equal(updated.fitSummary, "Revised fit summary");
});

test("deleteApplication removes an application and reports whether one was removed", () => {
  const store = createJobApplicationsStore({ dataDir: tempDir(), makeId: () => "id-1" });
  store.createApplication({ company: "Acme", role: "Engineer" });

  assert.equal(store.deleteApplication("id-1"), true);
  assert.deepEqual(store.listApplications(), []);
  assert.equal(store.deleteApplication("id-1"), false);
});

test("saveAnswer creates a new answer, defaulting label to key", () => {
  const store = createJobApplicationsStore({
    dataDir: tempDir(),
    now: () => "2026-01-01T00:00:00.000Z",
  });

  const answer = store.saveAnswer({ key: "AI-Experience", content: "I have worked with..." });
  assert.deepEqual(answer, {
    key: "ai-experience",
    label: "ai-experience",
    content: "I have worked with...",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
});

test("saveAnswer upserts by key instead of duplicating, preserving createdAt", () => {
  let clock = 0;
  const store = createJobApplicationsStore({
    dataDir: tempDir(),
    now: () => `t${++clock}`,
  });

  const first = store.saveAnswer({ key: "answer-1", content: "draft one", label: "Answer One" });
  const second = store.saveAnswer({ key: "answer-1", content: "draft two" });

  assert.equal(store.listAnswers().length, 1);
  assert.equal(second.content, "draft two");
  assert.equal(second.createdAt, first.createdAt);
  assert.notEqual(second.updatedAt, first.updatedAt);
  // label persists from the original save when not supplied again
  assert.equal(second.label, "Answer One");
});

test("saveAnswer rejects a missing key or content", () => {
  const store = createJobApplicationsStore({ dataDir: tempDir() });
  assert.throws(
    () => store.saveAnswer({ key: "", content: "x" }),
    /key is required/,
  );
  assert.throws(
    () => store.saveAnswer({ key: "x", content: "" }),
    /content is required/,
  );
});

test("getAnswer and deleteAnswer are case-insensitive on key", () => {
  const store = createJobApplicationsStore({ dataDir: tempDir() });
  store.saveAnswer({ key: "AI-Experience", content: "content" });

  assert.ok(store.getAnswer("ai-experience"));
  assert.ok(store.getAnswer("AI-EXPERIENCE"));
  assert.equal(store.deleteAnswer("Ai-Experience"), true);
  assert.equal(store.listAnswers().length, 0);
});

test("data persists across separate store instances pointed at the same directory", () => {
  const dir = tempDir();
  const storeA = createJobApplicationsStore({ dataDir: dir, makeId: () => "id-1" });
  storeA.createApplication({ company: "Persisted Co", role: "Engineer" });
  storeA.saveAnswer({ key: "persisted-answer", content: "content" });

  const storeB = createJobApplicationsStore({ dataDir: dir });
  assert.equal(storeB.listApplications()[0].company, "Persisted Co");
  assert.ok(storeB.getAnswer("persisted-answer"));
});

test("a malformed data file is treated as empty rather than throwing", () => {
  const dir = tempDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "job-applications.json"), "{not valid json", "utf8");
  const store = createJobApplicationsStore({ dataDir: dir });
  assert.deepEqual(store.listApplications(), []);
  assert.deepEqual(store.listAnswers(), []);
});
