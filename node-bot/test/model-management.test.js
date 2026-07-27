const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createModelManagement,
  detectGpuVramMb,
  detectSystemMemoryMb,
  recommendModelProfile,
} = require("../model-management");

function fakeModelSettingsStore(initialPath = null) {
  let modelPath = initialPath;
  let brain = { type: "local", baseUrl: "", apiKey: "", model: "" };
  let vision = { modelPath: "", mmprojPath: "" };
  return {
    getModelPath: () => modelPath,
    setModelPath: (p) => {
      modelPath = p || null;
      return modelPath;
    },
    getBrainSettings: () => ({ ...brain }),
    setBrainSettings: (partial = {}) => {
      brain = { ...brain, ...partial };
      return { ...brain };
    },
    getVisionSettings: () => ({ ...vision }),
    setVisionSettings: (partial = {}) => {
      vision = { ...vision, ...partial };
      return { ...vision };
    },
  };
}

test("model management reports available and missing profile candidates", () => {
  const root = path.join("C:", "ManaAI", "Mana", "tools", "llama", "gguf-models");
  const fourB = path.join(root, "Qwen3-4B-Q4_K_M.gguf");
  const onePointFiveB = path.join(root, "qwen2.5-1.5b-instruct-q4_k_m.gguf");
  const manager = createModelManagement({
    env: {},
    localGgufs: [fourB, onePointFiveB],
    modelSettingsStore: fakeModelSettingsStore(),
  });

  const status = manager.getModelStatus();

  assert.equal(status.activeProfile, "default");
  assert.equal(status.remoteAiEnabled, false);
  assert.equal(status.remoteAiWarning, null);
  assert.equal(status.profiles.default.label, "Default chat");
  assert.equal(status.profiles.default.available, true);
  assert.equal(status.profiles.default.selectedModel, fourB);
  assert.equal(status.profiles.fast.selectedModel, onePointFiveB);
  assert.equal(
    status.profiles.quality.missing.includes("Qwen3-8B-Q4_K_M.gguf"),
    true,
  );
  assert.deepEqual(
    status.profiles.default.candidates.map((candidate) => candidate.name),
    [
      "Qwen3-4B-Q4_K_M.gguf",
      "qwen2.5-1.5b-instruct-q4_k_m.gguf",
      "Qwen3-8B-Q4_K_M.gguf",
    ],
  );
});

test("quality profile prefers a 14B-class model over the 8B fallback when both are present", () => {
  const root = path.join("C:", "ManaAI", "Mana", "tools", "llama", "gguf-models");
  const fourteenB = path.join(root, "Qwen3-14B-Q4_K_M.gguf");
  const eightB = path.join(root, "Qwen3-8B-Q4_K_M.gguf");
  const manager = createModelManagement({
    env: {},
    localGgufs: [eightB, fourteenB],
    modelSettingsStore: fakeModelSettingsStore(),
  });

  assert.equal(manager.getModelStatus().profiles.quality.selectedModel, fourteenB);
});

test("model management switches active profile and rejects unknown profiles", () => {
  const manager = createModelManagement({
    env: {},
    localGgufs: [],
    modelSettingsStore: fakeModelSettingsStore(),
  });

  assert.equal(manager.getActiveProfile(), "default");
  assert.equal(manager.setActiveProfile("coding").activeProfile, "coding");
  assert.equal(manager.getActiveProfile(), "coding");
  assert.throws(
    () => manager.setActiveProfile("unknown"),
    /profile must be one of: default, fast, quality, coding/,
  );
  assert.equal(manager.getActiveProfile(), "coding");
});

test("model management warns when remote AI is enabled", () => {
  const manager = createModelManagement({
    env: {
      OPENAI_API_KEY: "present",
      MANA_ALLOW_REMOTE_AI: "1",
    },
    localGgufs: [],
    modelSettingsStore: fakeModelSettingsStore(),
  });

  const status = manager.getModelStatus();

  assert.equal(status.remoteAiEnabled, true);
  assert.match(status.remoteAiWarning, /Remote AI is enabled/i);
});

test("setBrainSettings switches to a local OpenAI-compatible endpoint without needing MANA_ALLOW_REMOTE_AI", () => {
  const manager = createModelManagement({
    env: {}, // no OPENAI_API_KEY, no MANA_ALLOW_REMOTE_AI
    localGgufs: [],
    modelSettingsStore: fakeModelSettingsStore(),
  });

  // Before switching: local brain, remote AI stays off.
  assert.equal(manager.getModelStatus().remoteAiEnabled, false);

  const status = manager.setBrainSettings({
    type: "openai_compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "llama3",
  });

  assert.equal(status.remoteAiEnabled, true);
  assert.equal(status.brain.type, "openai_compatible");
  assert.equal(status.brain.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(status.brain.model, "llama3");
});

test("getModelStatus never echoes back a stored apiKey", () => {
  const manager = createModelManagement({
    env: {},
    localGgufs: [],
    modelSettingsStore: fakeModelSettingsStore(),
  });

  const status = manager.setBrainSettings({
    type: "openai_compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "sk-super-secret",
  });

  assert.equal(status.brain.apiKey, undefined);
  assert.equal(status.brain.hasApiKey, true);
  assert.equal(JSON.stringify(status).includes("sk-super-secret"), false);
});

test("setBrainSettings rejects an invalid type or baseUrl", () => {
  const manager = createModelManagement({
    env: {},
    localGgufs: [],
    modelSettingsStore: fakeModelSettingsStore(),
  });

  assert.throws(
    () => manager.setBrainSettings({ type: "not-a-real-type" }),
    /type must be/,
  );
  assert.throws(
    () => manager.setBrainSettings({ baseUrl: "not a url" }),
    /not a valid URL/,
  );
  assert.throws(
    () => manager.setBrainSettings({ baseUrl: "file:///etc/passwd" }),
    /must be http:\/\/ or https:\/\//,
  );
});

test("getKnownBrainProviders lists presets without leaking anything key-shaped", () => {
  const manager = createModelManagement({
    env: {},
    localGgufs: [],
    modelSettingsStore: fakeModelSettingsStore(),
  });

  const providers = manager.getKnownBrainProviders();
  const ollama = providers.find((p) => p.id === "ollama");
  assert.equal(ollama.label, "Ollama (local)");
  assert.equal(ollama.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(ollama.needsKey, false);
  assert.equal(providers.some((p) => p.id === "custom"), true);
});

test("testBrainConnection reports ok with a model count on success", async () => {
  const manager = createModelManagement({
    env: {},
    localGgufs: [],
    modelSettingsStore: fakeModelSettingsStore(),
  });
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(String(url), "http://127.0.0.1:11434/v1/models");
    assert.equal(options.headers.Authorization, undefined);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "llama3" }, { id: "qwen" }] }),
    };
  };
  try {
    const result = await manager.testBrainConnection({ baseUrl: "http://127.0.0.1:11434/v1" });
    assert.equal(result.ok, true);
    assert.equal(result.modelCount, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test("testBrainConnection sends the API key and surfaces a non-ok status", async () => {
  const manager = createModelManagement({
    env: {},
    localGgufs: [],
    modelSettingsStore: fakeModelSettingsStore(),
  });
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(options.headers.Authorization, "Bearer sk-test");
    return { ok: false, status: 401 };
  };
  try {
    const result = await manager.testBrainConnection({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  } finally {
    global.fetch = originalFetch;
  }
});

test("testBrainConnection rejects a missing or invalid baseUrl", async () => {
  const manager = createModelManagement({
    env: {},
    localGgufs: [],
    modelSettingsStore: fakeModelSettingsStore(),
  });

  assert.equal((await manager.testBrainConnection({})).ok, false);
  assert.match(
    (await manager.testBrainConnection({ baseUrl: "not a url" })).error,
    /not a valid URL/,
  );
  assert.match(
    (await manager.testBrainConnection({ baseUrl: "file:///etc/passwd" })).error,
    /must be http:\/\/ or https:\/\//,
  );
});

test("setVisionSettings persists a valid .gguf pair and rejects a missing file", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-vision-test-"));
  try {
    const modelPath = path.join(tempDir, "qwen2.5-vl-3b.gguf");
    const mmprojPath = path.join(tempDir, "qwen2.5-vl-mmproj.gguf");
    fs.writeFileSync(modelPath, "GGUF" + "\0".repeat(12));
    fs.writeFileSync(mmprojPath, "GGUF" + "\0".repeat(12));

    const manager = createModelManagement({
      env: {},
      localGgufs: [],
      modelSettingsStore: fakeModelSettingsStore(),
    });

    const status = manager.setVisionSettings({ modelPath, mmprojPath });
    assert.equal(status.vision.modelPath, modelPath);
    assert.equal(status.vision.mmprojPath, mmprojPath);

    assert.throws(
      () =>
        manager.setVisionSettings({
          modelPath: path.join(tempDir, "does-not-exist.gguf"),
        }),
      /File not found/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test("setVisionSettings rejects a .gguf-named file that isn't actually a GGUF", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-vision-magic-test-"));
  try {
    const fakePath = path.join(tempDir, "not-really-a-model.gguf");
    fs.writeFileSync(fakePath, "this is not a gguf file");

    const manager = createModelManagement({
      env: {},
      localGgufs: [],
      modelSettingsStore: fakeModelSettingsStore(),
    });

    assert.throws(
      () => manager.setVisionSettings({ modelPath: fakePath }),
      /does not look like a valid GGUF/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test("detectGpuVramMb parses nvidia-smi output and returns null on failure", () => {
  const fakeSpawnSync = (bin, args) => ({
    status: 0,
    stdout: "8192\n",
  });
  assert.equal(detectGpuVramMb(fakeSpawnSync), 8192);

  assert.equal(detectGpuVramMb(() => ({ status: 1, stdout: "" })), null);
  assert.equal(detectGpuVramMb(() => ({ status: 0, stdout: "" })), null);
  assert.equal(
    detectGpuVramMb(() => ({ status: 0, stdout: "not-a-number\n" })),
    null,
  );
  assert.equal(
    detectGpuVramMb(() => {
      throw new Error("nvidia-smi not found");
    }),
    null,
  );
  assert.equal(
    detectGpuVramMb(() => ({ error: new Error("ENOENT"), status: null })),
    null,
  );
});

test("detectSystemMemoryMb converts bytes to whole megabytes", () => {
  assert.equal(detectSystemMemoryMb(() => 34_359_738_368), 32768);
  assert.equal(detectSystemMemoryMb(() => 0), null);
  assert.equal(detectSystemMemoryMb(() => NaN), null);
});

test("recommendModelProfile picks a tier from VRAM when available", () => {
  assert.equal(recommendModelProfile({ vramMb: 8192, ramMb: 65536 }).profile, "default");
  assert.equal(recommendModelProfile({ vramMb: 6144, ramMb: 65536 }).profile, "fast");
  assert.equal(recommendModelProfile({ vramMb: 16384, ramMb: 8192 }).profile, "quality");
  assert.match(recommendModelProfile({ vramMb: 6144, ramMb: null }).reason, /nvidia-smi/i);
});

test("recommendModelProfile treats a real 16GB card as quality despite nvidia-smi under-reporting", () => {
  // A real 16GB card typically reports ~16000-16300MB via nvidia-smi
  // (driver/OS reservations), never the full 16384 -- the tier boundary
  // must sit below that or a genuine 16GB upgrade gets silently
  // recommended "default" instead of "quality".
  assert.equal(recommendModelProfile({ vramMb: 16043, ramMb: 8192 }).profile, "quality");
  assert.equal(recommendModelProfile({ vramMb: 15359, ramMb: 8192 }).profile, "default");
});

test("recommendModelProfile falls back to system RAM when VRAM is unknown", () => {
  const result = recommendModelProfile({ vramMb: null, ramMb: 8192 });
  assert.equal(result.profile, "fast");
  assert.match(result.reason, /could not be detected/i);
  assert.match(result.reason, /rough proxy/i);

  assert.equal(
    recommendModelProfile({ vramMb: null, ramMb: 24576 }).profile,
    "default",
  );
  assert.equal(
    recommendModelProfile({ vramMb: null, ramMb: 65536 }).profile,
    "quality",
  );
});

test("recommendModelProfile defaults to fast when nothing could be detected", () => {
  const result = recommendModelProfile({ vramMb: null, ramMb: null });
  assert.equal(result.profile, "fast");
  assert.match(result.reason, /could not detect/i);
});

test("model management surfaces and caches a hardware recommendation", () => {
  let spawnCalls = 0;
  const manager = createModelManagement({
    env: {},
    localGgufs: [],
    spawnSync: () => {
      spawnCalls += 1;
      return { status: 0, stdout: "6144\n" };
    },
    totalmem: () => 34_359_738_368,
    modelSettingsStore: fakeModelSettingsStore(),
  });

  const first = manager.getRecommendedModelProfile();
  assert.equal(first.profile, "fast");
  assert.equal(first.label, "Fast fallback");
  assert.deepEqual(first.detected, { vramMb: 6144, ramMb: 32768 });

  manager.getRecommendedModelProfile();
  manager.getModelStatus();
  assert.equal(spawnCalls, 1, "hardware detection should be cached, not re-run per call");

  assert.deepEqual(manager.getModelStatus().recommendation, first);
});

test("setModelPath persists a valid .gguf file and reports it in getModelStatus", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mana-model-select-"));
  const picked = path.join(root, "custom.gguf");
  fs.writeFileSync(picked, "GGUF" + "\0".repeat(12));
  const store = fakeModelSettingsStore();
  const manager = createModelManagement({
    env: {},
    localGgufs: [],
    modelSettingsStore: store,
  });

  try {
    const status = manager.setModelPath(picked);
    assert.equal(status.selectedModelPath, picked);
    assert.equal(manager.getModelStatus().selectedModelPath, picked);
    assert.equal(manager.getModelStatus().profiles.default.selectedModel, picked);

    const cleared = manager.setModelPath(null);
    assert.equal(cleared.selectedModelPath, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("setModelPath rejects non-gguf paths and missing files", () => {
  const manager = createModelManagement({
    env: {},
    localGgufs: [],
    modelSettingsStore: fakeModelSettingsStore(),
  });

  assert.throws(() => manager.setModelPath("C:\\models\\a.txt"), /must point to a \.gguf file/);
  assert.throws(
    () => manager.setModelPath("C:\\does\\not\\exist.gguf"),
    /Model file not found/,
  );
});

test("setModelPath rejects a .gguf-named file that isn't actually a GGUF", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mana-model-magic-"));
  try {
    const fakePath = path.join(root, "definitely-not-a-model.gguf");
    fs.writeFileSync(fakePath, "not a gguf");
    const manager = createModelManagement({
      env: {},
      localGgufs: [],
      modelSettingsStore: fakeModelSettingsStore(),
    });
    assert.throws(
      () => manager.setModelPath(fakePath),
      /does not look like a valid GGUF/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scanForModels finds .gguf files under the given roots and skips unreadable directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mana-model-scan-"));
  const nested = path.join(root, "sub");
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(root, "top.gguf"), "model");
  fs.writeFileSync(path.join(nested, "nested.gguf"), "model");
  fs.writeFileSync(path.join(nested, "not-a-model.txt"), "nope");
  // A directory entry that doesn't actually exist as readable: exercises the
  // scanner's per-directory try/catch instead of aborting the whole scan.
  const ghostDir = path.join(root, "ghost");

  const manager = createModelManagement({
    env: {},
    localGgufs: [],
    modelSettingsStore: fakeModelSettingsStore(),
  });

  try {
    const result = manager.scanForModels([root, ghostDir]);
    const names = result.found.map((m) => m.name).sort();
    assert.deepEqual(names, ["nested.gguf", "top.gguf"]);
    assert.equal(result.truncated, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
