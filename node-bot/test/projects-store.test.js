const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createProjectsStore } = require("../projects-store");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-projects-store-"));
}

test("same-name projects are distinct and validation cannot overwrite another project", () => {
  const dir = tempDir();
  try {
    const store = createProjectsStore({ dataDir: dir });
    const first = store.upsertProject({ name: 'Alpha', instructions: 'Original' });
    const second = store.upsertProject({ name: 'Alpha' });
    assert.notEqual(first.id, second.id);
    for (const id of ['../escape', '__proto__', 'constructor', 'prototype']) {
      assert.throws(() => store.upsertProject({ id, name: 'Bad' }), /Invalid project ID/);
      assert.equal(store.getProject(id), null);
    }
    assert.throws(() => store.upsertProject({ id: first.id, instructions: 'x'.repeat(8001) }), /8000/);
    assert.equal(store.getProject(first.id).instructions, 'Original');
    assert.equal(store.listProjects().length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('corrupted project state is reported without overwriting the original file', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'projects.json');
    fs.writeFileSync(file, '{broken');
    const store = createProjectsStore({ dataDir: dir });
    assert.throws(() => store.upsertProject({ name: 'Replacement' }), /Cannot read project data/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("forks inherit projects until explicitly detached and deletion does not resurrect assignments", () => {
  const dir = tempDir();
  try {
    const parents = { child: 'parent', grandchild: 'child', loopA: 'loopB', loopB: 'loopA' };
    const store = createProjectsStore({ dataDir: dir, getSession: id => ({ forkedFrom: parents[id] }) });
    store.upsertProject({ id: 'alpha', name: 'Alpha' });
    store.assignSession('parent', 'alpha');
    assert.equal(store.projectForSession('grandchild').id, 'alpha');
    store.assignSession('child', null);
    assert.equal(store.projectForSession('child'), null);
    assert.equal(store.projectForSession('grandchild'), null);
    assert.equal(store.projectForSession('loopA'), null);
    store.deleteProject('alpha');
    store.upsertProject({ id: 'alpha', name: 'Replacement' });
    assert.equal(store.projectForSession('parent'), null);
    assert.equal(createProjectsStore({ dataDir: dir }).projectForSession('child'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
    assert.doesNotMatch(store.promptBlockForSession("chat-1"), /Run npm test before commits/);

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
