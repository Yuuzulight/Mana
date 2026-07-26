const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createSkillsStore, parseSkillFile, serializeSkillFile } = require("../skills-store");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-skills-test-"));
}

test("createSkillsStore starts empty and creates a skill with the right frontmatter", () => {
  const store = createSkillsStore({
    skillsDir: tempDir(),
    now: () => "2026-01-01T00:00:00.000Z",
  });

  assert.deepEqual(store.listSkills(), []);

  const skill = store.createSkill({
    name: "Restart SearXNG",
    description: "How to bring SearXNG back up if web search stops working.",
    body: "1. Check the process.\n2. Restart it.",
  });

  assert.equal(skill.name, "Restart SearXNG");
  assert.equal(skill.category, "general");
  assert.equal(skill.created, "2026-01-01T00:00:00.000Z");
  assert.equal(skill.lastUsed, "2026-01-01T00:00:00.000Z");
  assert.equal(skill.status, "active");
  assert.equal(skill.fileName, "restart-searxng.md");

  const listed = store.listSkills();
  assert.equal(listed.length, 1);
  // The cheap index has no body -- this is the whole point of the
  // two-level loading the issue asks for.
  assert.equal(listed[0].body, undefined);
  assert.equal(listed[0].name, "Restart SearXNG");
  assert.equal(listed[0].description, skill.description);
});

test("createSkill rejects missing fields and duplicate names", () => {
  const store = createSkillsStore({ skillsDir: tempDir() });
  assert.throws(() => store.createSkill({ name: "", description: "d", body: "b" }), /name is required/);
  assert.throws(
    () => store.createSkill({ name: "n", description: "", body: "b" }),
    /description is required/,
  );
  assert.throws(
    () => store.createSkill({ name: "n", description: "d", body: "" }),
    /body is required/,
  );

  store.createSkill({ name: "Dup", description: "d", body: "b" });
  assert.throws(
    () => store.createSkill({ name: "Dup", description: "d2", body: "b2" }),
    /already exists/,
  );
});

test("viewSkill returns the full body and touches lastUsed", () => {
  const dir = tempDir();
  let clock = "2026-01-01T00:00:00.000Z";
  const store = createSkillsStore({ skillsDir: dir, now: () => clock });
  store.createSkill({ name: "My Skill", description: "desc", body: "full body here" });

  clock = "2026-02-01T00:00:00.000Z";
  const viewed = store.viewSkill("My Skill");
  assert.equal(viewed.body, "full body here");
  assert.equal(viewed.lastUsed, "2026-02-01T00:00:00.000Z");

  // Persisted, not just returned in-memory -- a fresh store instance
  // pointed at the same directory sees the same bumped lastUsed.
  const store2 = createSkillsStore({ skillsDir: dir });
  const listed = store2.listSkills();
  assert.equal(listed[0].lastUsed, "2026-02-01T00:00:00.000Z");
});

test("viewSkill returns null for an unknown skill", () => {
  const store = createSkillsStore({ skillsDir: tempDir() });
  assert.equal(store.viewSkill("nope"), null);
});

test("pruneStaleSkills flags skills unused past staleDays and archives past archiveDays", () => {
  const dir = tempDir();
  const store = createSkillsStore({
    skillsDir: dir,
    now: () => "2026-04-01T00:00:00.000Z",
  });

  // Fresh -- untouched.
  store.createSkill({ name: "Fresh", description: "d", body: "b" });

  // 40 days old -- past the default 30-day stale threshold, short of 90.
  const staleStore = createSkillsStore({ skillsDir: dir, now: () => "2026-02-20T00:00:00.000Z" });
  staleStore.createSkill({ name: "Getting Stale", description: "d", body: "b" });

  // 100 days old -- past the default 90-day archive threshold.
  const archiveStore = createSkillsStore({ skillsDir: dir, now: () => "2025-12-22T00:00:00.000Z" });
  archiveStore.createSkill({ name: "Long Forgotten", description: "d", body: "b" });

  const result = store.pruneStaleSkills({});
  assert.deepEqual(result.staled, ["Getting Stale"]);
  assert.deepEqual(result.archived, ["Long Forgotten"]);

  const remaining = store.listSkills();
  assert.deepEqual(
    remaining.map((s) => s.name).sort(),
    ["Fresh", "Getting Stale"],
  );
  assert.equal(remaining.find((s) => s.name === "Getting Stale").status, "stale");
  assert.equal(remaining.find((s) => s.name === "Fresh").status, "active");

  // Archived skills are moved out of the main dir entirely.
  assert.equal(fs.existsSync(path.join(dir, "long-forgotten.md")), false);
  assert.equal(fs.existsSync(path.join(dir, ".archive", "long-forgotten.md")), true);
});

test("using a stale skill un-stales it", () => {
  const dir = tempDir();
  const oldStore = createSkillsStore({ skillsDir: dir, now: () => "2026-01-01T00:00:00.000Z" });
  oldStore.createSkill({ name: "Old Skill", description: "d", body: "b" });

  // 40 days later -- past the default 30-day stale threshold, short of the
  // 90-day archive one.
  const nowStore = createSkillsStore({ skillsDir: dir, now: () => "2026-02-10T00:00:00.000Z" });
  nowStore.pruneStaleSkills({});
  assert.equal(nowStore.listSkills()[0].status, "stale");

  nowStore.viewSkill("Old Skill");
  assert.equal(nowStore.listSkills()[0].status, "active");
});

test("parseSkillFile falls back to a bare body when frontmatter is missing", () => {
  const parsed = parseSkillFile("just some text, no frontmatter", "fallback-name");
  assert.equal(parsed.name, "fallback-name");
  assert.equal(parsed.body, "just some text, no frontmatter");
  assert.equal(parsed.status, "active");
});

test("serializeSkillFile round-trips through parseSkillFile", () => {
  const skill = {
    name: "Round Trip",
    description: "desc",
    category: "general",
    created: "2026-01-01T00:00:00.000Z",
    lastUsed: "2026-01-01T00:00:00.000Z",
    status: "active",
    body: "line one\nline two",
  };
  const parsed = parseSkillFile(serializeSkillFile(skill), "unused");
  assert.deepEqual(parsed, skill);
});
