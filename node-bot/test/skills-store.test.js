const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createSkillsStore, parseSkillFile, serializeSkillFile, extractSkillScript, extractSkillInputs, verifySkillScript } = require("../skills-store");

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

test("createSkill rejects a name that only differs in case from an existing skill's slug", () => {
  const store = createSkillsStore({ skillsDir: tempDir() });
  store.createSkill({ name: "Restart SearXNG", description: "d", body: "b" });
  // Different display-name casing, same slugified filename -- must not
  // silently overwrite the first skill's file.
  assert.throws(
    () => store.createSkill({ name: "restart searxng", description: "d2", body: "b2" }),
    /already exists/,
  );
});

test("createSkill and updateSkill reject line breaks in name/description/category", () => {
  const store = createSkillsStore({ skillsDir: tempDir() });
  assert.throws(
    () => store.createSkill({ name: "Bad\nName", description: "d", body: "b" }),
    /name cannot contain line breaks/,
  );
  assert.throws(
    () => store.createSkill({ name: "n", description: "bad\ndesc", body: "b" }),
    /description cannot contain line breaks/,
  );
  assert.throws(
    () => store.createSkill({ name: "n2", description: "d", category: "bad\ncat", body: "b" }),
    /category cannot contain line breaks/,
  );

  store.createSkill({ name: "Editable", description: "d", body: "b" });
  assert.throws(
    () => store.updateSkill("Editable", { description: "bad\ndesc" }),
    /description cannot contain line breaks/,
  );
  assert.throws(
    () => store.updateSkill("Editable", { category: "bad\ncat" }),
    /category cannot contain line breaks/,
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

test("viewSkill with touch:false leaves lastUsed/status untouched", () => {
  const dir = tempDir();
  let clock = "2026-01-01T00:00:00.000Z";
  const store = createSkillsStore({ skillsDir: dir, now: () => clock });
  store.createSkill({ name: "Browsed Only", description: "desc", body: "body" });

  clock = "2026-02-01T00:00:00.000Z";
  const viewed = store.viewSkill("Browsed Only", { touch: false });
  assert.equal(viewed.body, "body");
  assert.equal(viewed.lastUsed, "2026-01-01T00:00:00.000Z");
  assert.equal(store.listSkills()[0].lastUsed, "2026-01-01T00:00:00.000Z");
});

test("viewSkill returns null for an unknown skill", () => {
  const store = createSkillsStore({ skillsDir: tempDir() });
  assert.equal(store.viewSkill("nope"), null);
});

test("useCount starts at 0 and increments each time the skill is actually viewed", () => {
  const dir = tempDir();
  const store = createSkillsStore({ skillsDir: dir });
  store.createSkill({ name: "Counted", description: "desc", body: "body" });
  assert.equal(store.listSkills()[0].useCount, 0);

  store.viewSkill("Counted");
  assert.equal(store.listSkills()[0].useCount, 1);
  store.viewSkill("Counted");
  assert.equal(store.listSkills()[0].useCount, 2);

  // touch:false must not count as a use -- browsing into Edit isn't Mana
  // actually reaching for the skill (same reasoning as the lastUsed test
  // above).
  store.viewSkill("Counted", { touch: false });
  assert.equal(store.listSkills()[0].useCount, 2);
});

test("extractSkillScript pulls the fenced skill-script block out of a body, or returns null", () => {
  assert.equal(extractSkillScript("just prose steps, no code"), null);
  assert.equal(
    extractSkillScript("Steps:\n1. do a thing\n```skill-script\nreturn 1 + 1;\n```\n2. done"),
    "return 1 + 1;",
  );
});

test("extractSkillInputs returns an empty array when the body has no skill-inputs block", () => {
  assert.deepEqual(extractSkillInputs("just prose steps, no code"), []);
});

test("extractSkillInputs parses name: description lines out of a fenced skill-inputs block", () => {
  const body = "Steps:\n```skill-inputs\nname: the person to greet\nformal: whether to use a formal greeting\n```\n```skill-script\nreturn inputs.name;\n```";
  assert.deepEqual(extractSkillInputs(body), [
    { name: "name", description: "the person to greet" },
    { name: "formal", description: "whether to use a formal greeting" },
  ]);
});

test("extractSkillInputs skips malformed lines (no colon) instead of failing", () => {
  const body = "```skill-inputs\nname: the person to greet\njust garbage\n```";
  assert.deepEqual(extractSkillInputs(body), [{ name: "name", description: "the person to greet" }]);
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

test("updateSkill patches only the fields provided and persists them", () => {
  const dir = tempDir();
  const store = createSkillsStore({ skillsDir: dir, now: () => "2026-01-01T00:00:00.000Z" });
  store.createSkill({ name: "Editable", description: "old desc", body: "old body", category: "general" });

  const updated = store.updateSkill("Editable", { description: "new desc" });
  assert.equal(updated.description, "new desc");
  assert.equal(updated.body, "old body");
  assert.equal(updated.category, "general");

  const updated2 = store.updateSkill("Editable", { body: "new body", category: "custom" });
  assert.equal(updated2.description, "new desc");
  assert.equal(updated2.body, "new body");
  assert.equal(updated2.category, "custom");

  // Persisted, not just returned in-memory.
  const store2 = createSkillsStore({ skillsDir: dir });
  const viewed = store2.viewSkill("Editable");
  assert.equal(viewed.description, "new desc");
  assert.equal(viewed.body, "new body");
  assert.equal(viewed.category, "custom");
});

test("updateSkill treats category: null as an explicit reset to general", () => {
  const store = createSkillsStore({ skillsDir: tempDir() });
  store.createSkill({ name: "Categorized", description: "d", body: "b", category: "custom" });
  const updated = store.updateSkill("Categorized", { category: null });
  assert.equal(updated.category, "general");
});

test("updateSkill returns null for an unknown skill", () => {
  const store = createSkillsStore({ skillsDir: tempDir() });
  assert.equal(store.updateSkill("nope", { description: "x" }), null);
});

test("deleteSkill permanently removes the skill file", () => {
  const dir = tempDir();
  const store = createSkillsStore({ skillsDir: dir });
  store.createSkill({ name: "Removable", description: "d", body: "b" });
  assert.equal(fs.existsSync(path.join(dir, "removable.md")), true);

  assert.equal(store.deleteSkill("Removable"), true);
  assert.equal(fs.existsSync(path.join(dir, "removable.md")), false);
  assert.deepEqual(store.listSkills(), []);

  // Not archived -- gone entirely, unlike pruneStaleSkills.
  assert.equal(fs.existsSync(path.join(dir, ".archive", "removable.md")), false);
});

test("deleteSkill returns false for an unknown skill", () => {
  const store = createSkillsStore({ skillsDir: tempDir() });
  assert.equal(store.deleteSkill("nope"), false);
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
    useCount: 3,
    status: "active",
    // Issue #354: the parsed shape now always carries requires, empty when
    // the skill declared none.
    requires: [],
    permission: "always",
    body: "line one\nline two",
  };
  const parsed = parseSkillFile(serializeSkillFile(skill), "unused");
  assert.deepEqual(parsed, skill);
});

test("a skill declaring no requirements serializes without the field (issue #354)", () => {
  const serialized = serializeSkillFile({
    name: "No Deps",
    description: "desc",
    category: "general",
    created: "2026-01-01T00:00:00.000Z",
    lastUsed: "2026-01-01T00:00:00.000Z",
    useCount: 0,
    status: "active",
    requires: [],
    body: "body",
  });
  // An existing skill file has to be unchanged by a round-trip through this.
  assert.doesNotMatch(serialized, /requires:/);
});

test("requires round-trips as a list (issue #354)", () => {
  const skill = {
    name: "Needs Tools",
    description: "desc",
    category: "general",
    created: "2026-01-01T00:00:00.000Z",
    lastUsed: "2026-01-01T00:00:00.000Z",
    useCount: 0,
    status: "active",
    requires: ["read_file", "web_search"],
    permission: "always",
    body: "body",
  };
  assert.deepEqual(parseSkillFile(serializeSkillFile(skill), "unused"), skill);
});

test("listSkills marks a skill unavailable when a required tool is missing (issue #354)", () => {
  const store = createSkillsStore({ skillsDir: tempDir() });
  store.createSkill({
    name: "Search The Web",
    description: "looks things up",
    body: "steps",
    requires: ["web_search"],
  });

  const available = store.listSkills({ isToolAvailable: () => true });
  assert.equal(available[0].available, true);
  assert.deepEqual(available[0].missingRequirements, []);

  // The tool has gone away -- a plugin turned off, an MCP server down.
  const degraded = store.listSkills({ isToolAvailable: () => false });
  assert.equal(degraded[0].available, false);
  assert.deepEqual(degraded[0].missingRequirements, ["web_search"]);
  // Reported, not hidden: "exists but cannot run, and here is why" beats
  // silently not offering it.
  assert.equal(degraded[0].status, "active");
});

test("a skill with no declared requirements is always available (issue #354)", () => {
  const store = createSkillsStore({ skillsDir: tempDir() });
  store.createSkill({ name: "Plain", description: "d", body: "steps" });
  assert.equal(store.listSkills({ isToolAvailable: () => false })[0].available, true);
});

test("availability is unevaluated when no checker is supplied (issue #354)", () => {
  const store = createSkillsStore({ skillsDir: tempDir() });
  store.createSkill({ name: "Plain", description: "d", body: "s", requires: ["x"] });
  // Callers that do not know about tools keep working unchanged.
  assert.equal(store.listSkills()[0].available, true);
});

test("a skill whose script does not parse is refused (issue #356)", () => {
  const store = createSkillsStore({ skillsDir: tempDir() });
  assert.throws(
    () =>
      store.createSkill({
        name: "Broken",
        description: "d",
        body: "steps\n\n```skill-script\nreturn (;\n```",
      }),
    /does not parse/,
  );
  // Storing it would only defer the failure to whoever reached for it next.
  assert.equal(store.listSkills().length, 0);
});

test("a skill with a valid script is stored (issue #356)", () => {
  const store = createSkillsStore({ skillsDir: tempDir() });
  store.createSkill({
    name: "Fine",
    description: "d",
    body: "steps\n\n```skill-script\nconst x = await tools.read_file({ path: 'a' });\nreturn x;\n```",
  });
  assert.equal(store.listSkills().length, 1);
});

test("await at the top level parses, matching how the worker wraps it (issue #356)", () => {
  // The worker compiles `(async () => { ... })()`, so bare await is legal
  // inside a skill script. Checking it any other way would reject scripts
  // that actually run fine.
  assert.equal(verifySkillScript("```skill-script\nawait tools.noop();\n```").ok, true);
});

test("a skill with no script block is not rejected (issue #356)", () => {
  const store = createSkillsStore({ skillsDir: tempDir() });
  store.createSkill({ name: "Prose Only", description: "d", body: "just instructions" });
  assert.equal(store.listSkills().length, 1);
  assert.equal(verifySkillScript("just instructions").checked, false);
});

test("a hand-dropped skill file is reported as unmanaged (issue #393)", () => {
  const dir = tempDir();
  const store = createSkillsStore({ skillsDir: dir });
  store.createSkill({ name: "Proper", description: "made properly", body: "steps" });
  // Someone writes a skill by hand, or copies one in from a backup.
  fs.writeFileSync(path.join(dir, "hand-written.md"), "just some instructions\n", "utf8");

  const unmanaged = store.listUnmanagedSkills();
  assert.equal(unmanaged.length, 1);
  assert.equal(unmanaged[0].fileName, "hand-written.md");
  assert.ok(unmanaged[0].reasons.includes("no frontmatter"));
});

test("a properly created skill is never reported as unmanaged (issue #393)", () => {
  const store = createSkillsStore({ skillsDir: tempDir() });
  store.createSkill({ name: "Proper", description: "made properly", body: "steps" });
  assert.deepEqual(store.listUnmanagedSkills(), []);
});

test("a filename that disagrees with the name inside is flagged (issue #393)", () => {
  const dir = tempDir();
  const store = createSkillsStore({ skillsDir: dir });
  fs.writeFileSync(
    path.join(dir, "wrong-name.md"),
    "---\nname: Actual Name\ndescription: d\ncategory: general\ncreated: 2026-01-01\nlastUsed: 2026-01-01\nuseCount: 0\nstatus: active\n---\n\nbody\n",
    "utf8",
  );

  const [entry] = store.listUnmanagedSkills();
  assert.equal(entry.name, "Actual Name");
  assert.ok(entry.reasons.some((r) => /filename does not match/.test(r)));
});

test("adopting fills in bookkeeping without touching the body (issue #393)", () => {
  const dir = tempDir();
  const store = createSkillsStore({ skillsDir: dir });
  fs.writeFileSync(path.join(dir, "hand-written.md"), "the actual instructions\n", "utf8");

  const before = store.listUnmanagedSkills();
  const adopted = store.adoptSkill(before[0].name);
  assert.ok(adopted.created);
  assert.equal(adopted.useCount, 0);
  assert.equal(adopted.status, "active");
  // The instructions are the part the user cared about.
  assert.match(adopted.body, /the actual instructions/);
  assert.ok(!store.listUnmanagedSkills().some((u) => u.reasons.includes("no frontmatter")));
});

test("adopting an unknown skill returns null (issue #393)", () => {
  const store = createSkillsStore({ skillsDir: tempDir() });
  assert.equal(store.adoptSkill("nope"), null);
});
