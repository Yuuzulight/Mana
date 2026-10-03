const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createProjectsStore } = require("../projects-store");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-projects-store-"));
}

test("projects store upserts projects, assigns sessions, and builds prompt blocks", () => {
  const dir = tempDir();
  try {
    const ref = path.join(dir, "README.md");
    fs.writeFileSync(ref, "Run npm test before commits.\n");
    const store = createProjectsStore({ dataDir: dir, now: () => "2026-01-01T00:00:00.000Z" });

    const project = store.upsertProject({
      name: "Mana Core",
      instructions: "Use small diffs.\nPreserve local-first behavior.",
      references: [{ path: ref, label: "Repo notes" }],
    });
    assert.equal(project.id, "mana-core");
    assert.equal(project.instructions, "Use small diffs.\nPreserve local-first behavior.");
    assert.deepEqual(store.listProjects().map((p) => p.id), ["mana-core"]);

    assert.equal(store.assignSession("chat-1", "mana-core").id, "mana-core");
    assert.equal(store.projectForSession("chat-1").name, "Mana Core");
    assert.match(store.promptBlockForSession("chat-1"), /Standing instructions:\nUse small diffs/);
    assert.match(store.promptBlockForSession("chat-1"), /Reference: Repo notes/);
    assert.match(store.promptBlockForSession("chat-1"), /\[BEGIN PROJECT REFERENCE CONTENT\]/);
    assert.match(store.promptBlockForSession("chat-1"), /Run npm test before commits/);

    assert.equal(store.assignSession("chat-1", null), null);
    assert.equal(store.projectForSession("chat-1"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("projects store deletes projects and clears session assignments", () => {
  const dir = tempDir();
  try {
    const store = createProjectsStore({ dataDir: dir });
    store.upsertProject({ id: "alpha", name: "Alpha" });
    store.assignSession("chat-1", "alpha");

    assert.equal(store.deleteProject("alpha"), true);
    assert.equal(store.deleteProject("alpha"), false);
    assert.equal(store.projectForSession("chat-1"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
