const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createPresetsStore } = require("../presets-store");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-presets-test-"));
}

test("createPresetsStore starts empty and creates a preset with trimmed fields", () => {
  const store = createPresetsStore({
    dataDir: tempDir(),
    now: () => "2026-01-01T00:00:00.000Z",
    makeId: () => "id-1",
  });

  assert.deepEqual(store.listPresets(), []);

  const preset = store.createPreset({
    name: "  Concise mode  ",
    instructions: "  Keep replies short.  ",
  });

  assert.deepEqual(preset, {
    id: "id-1",
    name: "Concise mode",
    instructions: "Keep replies short.",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(store.listPresets(), [preset]);
  assert.deepEqual(store.getPreset("id-1"), preset);
});

test("createPreset rejects a missing name or instructions", () => {
  const store = createPresetsStore({ dataDir: tempDir() });
  assert.throws(() => store.createPreset({ name: "", instructions: "x" }), /name is required/);
  assert.throws(
    () => store.createPreset({ name: "x", instructions: "" }),
    /instructions is required/,
  );
});

test("listPresets sorts alphabetically by name", () => {
  const store = createPresetsStore({ dataDir: tempDir() });
  store.createPreset({ name: "Zebra", instructions: "z" });
  store.createPreset({ name: "Apple", instructions: "a" });
  store.createPreset({ name: "Mango", instructions: "m" });

  assert.deepEqual(
    store.listPresets().map((p) => p.name),
    ["Apple", "Mango", "Zebra"],
  );
});

test("getPreset returns null for an unknown or missing id", () => {
  const store = createPresetsStore({ dataDir: tempDir() });
  assert.equal(store.getPreset("nope"), null);
  assert.equal(store.getPreset(null), null);
  assert.equal(store.getPreset(undefined), null);
});

test("updatePreset renames and/or updates instructions independently", () => {
  const store = createPresetsStore({ dataDir: tempDir(), makeId: () => "id-1" });
  store.createPreset({ name: "Original", instructions: "original instructions" });

  const renamed = store.updatePreset("id-1", { name: "Renamed" });
  assert.equal(renamed.name, "Renamed");
  assert.equal(renamed.instructions, "original instructions");

  const reinstructed = store.updatePreset("id-1", { instructions: "new instructions" });
  assert.equal(reinstructed.name, "Renamed");
  assert.equal(reinstructed.instructions, "new instructions");
});

test("updatePreset returns null for an unknown id and rejects clearing a field to empty", () => {
  const store = createPresetsStore({ dataDir: tempDir(), makeId: () => "id-1" });
  store.createPreset({ name: "Original", instructions: "instructions" });

  assert.equal(store.updatePreset("missing", { name: "x" }), null);
  assert.throws(() => store.updatePreset("id-1", { name: "" }), /name cannot be empty/);
  assert.throws(
    () => store.updatePreset("id-1", { instructions: "" }),
    /instructions cannot be empty/,
  );
});

test("deletePreset removes a preset and reports whether one was actually removed", () => {
  const store = createPresetsStore({ dataDir: tempDir(), makeId: () => "id-1" });
  store.createPreset({ name: "Original", instructions: "instructions" });

  assert.equal(store.deletePreset("id-1"), true);
  assert.deepEqual(store.listPresets(), []);
  assert.equal(store.deletePreset("id-1"), false);
});

test("presets persist across separate store instances pointed at the same directory", () => {
  const dir = tempDir();
  const storeA = createPresetsStore({ dataDir: dir, makeId: () => "id-1" });
  storeA.createPreset({ name: "Persisted", instructions: "instructions" });

  const storeB = createPresetsStore({ dataDir: dir });
  assert.deepEqual(
    storeB.listPresets().map((p) => p.name),
    ["Persisted"],
  );
});

test("a malformed presets.json file is treated as empty rather than throwing", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "presets.json"), "{not valid json", "utf8");
  const store = createPresetsStore({ dataDir: dir });
  assert.deepEqual(store.listPresets(), []);
});
