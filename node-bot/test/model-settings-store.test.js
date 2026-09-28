const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { createModelSettingsStore } = require("../model-settings-store");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-model-settings-test-"));
}

test("model-settings-store: brain settings default to local with empty fields", () => {
  const tempDir = createTempDir();
  try {
    const store = createModelSettingsStore({ dataDir: tempDir });
    assert.deepEqual(store.getBrainSettings(), {
      type: "local",
      baseUrl: "",
      apiKey: "",
      model: "",
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test("model-settings-store: setBrainSettings persists and merges partial updates", () => {
  const tempDir = createTempDir();
  try {
    const store = createModelSettingsStore({ dataDir: tempDir });
    store.setBrainSettings({
      type: "openai_compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3",
    });
    // Second call with only apiKey set should not clobber the earlier fields.
    const result = store.setBrainSettings({ apiKey: "sk-local" });
    assert.deepEqual(result, {
      type: "openai_compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "sk-local",
      model: "llama3",
    });

    // A fresh store instance reading the same dir sees the persisted value.
    const reloaded = createModelSettingsStore({ dataDir: tempDir });
    assert.deepEqual(reloaded.getBrainSettings(), result);
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test("model-settings-store: setBrainSettings rejects an unknown type back to local", () => {
  const tempDir = createTempDir();
  try {
    const store = createModelSettingsStore({ dataDir: tempDir });
    const result = store.setBrainSettings({ type: "something-else" });
    assert.equal(result.type, "local");
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test("model-settings-store: vision settings default empty and persist", () => {
  const tempDir = createTempDir();
  try {
    const store = createModelSettingsStore({ dataDir: tempDir });
    assert.deepEqual(store.getVisionSettings(), { modelPath: "", mmprojPath: "" });

    const result = store.setVisionSettings({
      modelPath: "C:\\models\\qwen2.5-vl.gguf",
      mmprojPath: "C:\\models\\qwen2.5-vl-mmproj.gguf",
    });
    assert.deepEqual(result, {
      modelPath: "C:\\models\\qwen2.5-vl.gguf",
      mmprojPath: "C:\\models\\qwen2.5-vl-mmproj.gguf",
    });

    const reloaded = createModelSettingsStore({ dataDir: tempDir });
    assert.deepEqual(reloaded.getVisionSettings(), result);
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test("model-settings-store: brain and vision settings persist independently of modelPath", () => {
  const tempDir = createTempDir();
  try {
    const store = createModelSettingsStore({ dataDir: tempDir });
    store.setModelPath("C:\\models\\qwen3-4b.gguf");
    store.setBrainSettings({ type: "openai_compatible", baseUrl: "http://localhost:1234/v1" });
    store.setVisionSettings({ modelPath: "C:\\models\\vision.gguf" });

    assert.equal(store.getModelPath(), "C:\\models\\qwen3-4b.gguf");
    assert.equal(store.getBrainSettings().baseUrl, "http://localhost:1234/v1");
    assert.equal(store.getVisionSettings().modelPath, "C:\\models\\vision.gguf");
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test("model-settings-store: load-into-VRAM defaults on, MANA_LLAMA_MMAP=1 turns it off, a saved choice beats both", () => {
  const tempDir = createTempDir();
  try {
    const store = createModelSettingsStore({ dataDir: tempDir });
    assert.equal(store.isLoadIntoVram({}), true);
    assert.equal(store.isLoadIntoVram({ MANA_LLAMA_MMAP: "1" }), false);
    assert.equal(store.isLoadIntoVram({ MANA_LLAMA_MMAP: "0" }), true);

    store.setLoadIntoVram(true);
    assert.equal(store.isLoadIntoVram({ MANA_LLAMA_MMAP: "1" }), true);
    store.setLoadIntoVram(false);
    // Persisted: a fresh store over the same dir reads it back.
    assert.equal(createModelSettingsStore({ dataDir: tempDir }).isLoadIntoVram({}), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});
