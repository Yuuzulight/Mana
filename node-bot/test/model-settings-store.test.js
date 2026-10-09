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
      providerId: null,
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
      providerId: null,
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

test("model-settings-store: fallback settings persist independently and keep the key encrypted", () => {
  const tempDir = createTempDir();
  try {
    const store = createModelSettingsStore({ dataDir: tempDir, secrets: fakeSecrets });
    assert.deepEqual(store.getFallbackSettings(), {
      enabled: false,
      timeoutSeconds: 0,
      providerId: null,
      baseUrl: "",
      apiKey: "",
      model: "",
    });

    const result = store.setFallbackSettings({
      enabled: true,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-fallback",
      model: "gpt-test",
    });
    assert.deepEqual(result, {
      enabled: true,
      timeoutSeconds: 0,
      providerId: null,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-fallback",
      model: "gpt-test",
    });
    assert.ok(!readFile(tempDir).includes("sk-fallback"));
    assert.match(readFile(tempDir), /"fallback"/);
    assert.equal(
      createModelSettingsStore({ dataDir: tempDir, secrets: fakeSecrets }).getFallbackSettings().apiKey,
      "sk-fallback",
    );
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

// #645: brain.apiKey is saved encrypted. A reversible fake stands in for
// DPAPI; the last test uses the real thing on Windows.
const fakeSecrets = {
  protect: (value) => `enc:${Buffer.from(value).toString("base64")}`,
  unprotect: (blob) => {
    if (!blob.startsWith("enc:")) throw new Error("bad blob");
    return Buffer.from(blob.slice(4), "base64").toString();
  },
};

function readFile(dir) {
  return fs.readFileSync(path.join(dir, "model-settings.json"), "utf8");
}

test("model-settings-store: the API key is saved encrypted and reloads (#645)", () => {
  const tempDir = createTempDir();
  try {
    createModelSettingsStore({ dataDir: tempDir, secrets: fakeSecrets }).setBrainSettings({ apiKey: "sk-secret" });
    assert.ok(!readFile(tempDir).includes("sk-secret"));
    assert.match(readFile(tempDir), /"apiKeyProtected"/);
    const reloaded = createModelSettingsStore({ dataDir: tempDir, secrets: fakeSecrets });
    assert.equal(reloaded.getBrainSettings().apiKey, "sk-secret");
    reloaded.setBrainSettings({ apiKey: "" });
    assert.ok(!readFile(tempDir).includes("apiKey"));
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test("model-settings-store: a plain-text API key from before #645 is encrypted on first read", () => {
  const tempDir = createTempDir();
  try {
    fs.writeFileSync(
      path.join(tempDir, "model-settings.json"),
      JSON.stringify({ brain: { type: "openai_compatible", baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk-legacy" } }),
    );
    const store = createModelSettingsStore({ dataDir: tempDir, secrets: fakeSecrets });
    assert.equal(store.getBrainSettings().apiKey, "sk-legacy");
    assert.ok(!readFile(tempDir).includes("sk-legacy"));
    assert.equal(createModelSettingsStore({ dataDir: tempDir, secrets: fakeSecrets }).getBrainSettings().apiKey, "sk-legacy");
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test("model-settings-store: an undecryptable key is left unset, and the rest still loads", () => {
  const tempDir = createTempDir();
  try {
    fs.writeFileSync(
      path.join(tempDir, "model-settings.json"),
      JSON.stringify({ brain: { type: "openai_compatible", baseUrl: "http://127.0.0.1:1/v1", apiKeyProtected: "not-a-blob" } }),
    );
    const brain = createModelSettingsStore({ dataDir: tempDir, secrets: fakeSecrets }).getBrainSettings();
    assert.equal(brain.apiKey, "");
    assert.equal(brain.baseUrl, "http://127.0.0.1:1/v1");
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test("model-settings-store: real DPAPI round trip", { skip: process.platform !== "win32" }, () => {
  const tempDir = createTempDir();
  try {
    createModelSettingsStore({ dataDir: tempDir }).setBrainSettings({ apiKey: "sk-dpapi" });
    assert.ok(!readFile(tempDir).includes("sk-dpapi"));
    assert.equal(createModelSettingsStore({ dataDir: tempDir }).getBrainSettings().apiKey, "sk-dpapi");
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

// #1426: providers -- each API account once; the uses pick one by id.
const providerSecrets = { protect: (v) => `enc:${v}`, unprotect: (b) => b.slice(4) };

test("model-settings-store: an older file's keys become providers, once per address and key (#1426)", () => {
  const tempDir = createTempDir();
  try {
    fs.writeFileSync(path.join(tempDir, "model-settings.json"), JSON.stringify({
      brain: { type: "openai_compatible", baseUrl: "https://api.openai.com/v1/", apiKeyProtected: "enc:sk-brain1234", model: "gpt-x" },
      fallback: { enabled: true, baseUrl: "https://api.openai.com/v1", apiKeyProtected: "enc:sk-brain1234", model: "gpt-y" },
      escalation: { enabled: true, apiKeyProtected: "enc:ds-key9876" },
    }));
    const store = createModelSettingsStore({ dataDir: tempDir, secrets: providerSecrets });
    const providers = store.listProviders();
    assert.deepEqual(providers.map((p) => [p.id, p.keyHint, p.usedBy]), [
      ["deepseek", "…9876", ["Self-work escalation"]],
      ["openai", "…1234", ["Main model", "Cloud fallback"]],
    ]);
    assert.equal(store.getBrainSettings().providerId, "openai");
    assert.equal(store.getFallbackSettings().apiKey, "sk-brain1234");
    assert.equal(store.getEscalationSettings().baseUrl, "https://api.deepseek.com");
    // The uses keep their own fields, for an older Mana.
    const saved = JSON.parse(fs.readFileSync(path.join(tempDir, "model-settings.json"), "utf8"));
    assert.equal(saved.brain.baseUrl, "https://api.openai.com/v1/");
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test("model-settings-store: providers are added once, their keys only hinted, and kept while a use picks them (#1426)", () => {
  const tempDir = createTempDir();
  try {
    const store = createModelSettingsStore({ dataDir: tempDir, secrets: providerSecrets });
    assert.deepEqual(store.listProviders(), []);
    const groq = store.addProvider({ preset: "groq", apiKey: "gsk-abcd" });
    assert.deepEqual([groq.id, groq.baseUrl, groq.hasKey, groq.keyHint], ["groq", "https://api.groq.com/openai/v1", true, "…abcd"]);
    assert.ok(!JSON.stringify(store.listProviders()).includes("gsk-abcd"), "the key never comes back");
    assert.throws(() => store.addProvider({ preset: "groq", apiKey: "x" }), /already added/);
    assert.throws(() => store.addProvider({ preset: "openai" }), /needs its API key/);
    assert.throws(() => store.addProvider({ preset: "nope" }), /Pick a provider/);
    assert.throws(() => store.addProvider({ preset: "custom", baseUrl: "ftp://x" }), /http/);
    assert.equal(store.addProvider({ preset: "ollama" }).hasKey, false);
    assert.equal(store.addProvider({ preset: "custom", baseUrl: "http://10.0.0.5:8000/v1" }).id, "custom");
    assert.equal(store.addProvider({ preset: "custom", baseUrl: "http://10.0.0.6:8000/v1" }).id, "custom-2");

    store.setFallbackSettings({ enabled: true, providerId: "groq", model: "llama-3" });
    assert.deepEqual([store.getFallbackSettings().baseUrl, store.getFallbackSettings().apiKey], ["https://api.groq.com/openai/v1", "gsk-abcd"]);
    assert.throws(() => store.setBrainSettings({ providerId: "missing" }), /isn't added/);
    assert.deepEqual(store.removeProvider("groq"), { removed: false, usedBy: ["Cloud fallback"] });
    store.updateProvider("groq", { apiKey: "gsk-wxyz" });
    assert.equal(store.getFallbackSettings().apiKey, "gsk-wxyz", "a new key reaches every use at once");
    store.setFallbackSettings({ providerId: null });
    assert.deepEqual(store.removeProvider("groq"), { removed: true });
    assert.equal(store.removeProvider("groq"), null);
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});
