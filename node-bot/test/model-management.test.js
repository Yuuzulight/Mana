const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createModelManagement,
  detectGpu,
  detectGpuVramMb,
  detectGpuVramUsageMb,
  detectSystemMemoryMb,
  estimateModelFit,
  recommendModelProfile,
} = require("../model-management");

function fakeModelSettingsStore(initialPath = null) {
  let modelPath = initialPath;
  let brain = { type: "local", baseUrl: "", apiKey: "", model: "" };
  let vision = { modelPath: "", mmprojPath: "" };
  let loadIntoVram = null;
  return {
    isLoadIntoVram: (env) => (loadIntoVram === null ? env.MANA_LLAMA_MMAP !== "1" : loadIntoVram),
    setLoadIntoVram: (value) => (loadIntoVram = value),
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

test("setBrainSettings refuses a cloud endpoint in local-only mode, but not a LAN one (#670)", () => {
  const store = fakeModelSettingsStore();
  const manager = createModelManagement({ env: {}, localGgufs: [], modelSettingsStore: store });
  const prior = process.env.MANA_LOCAL_ONLY;
  process.env.MANA_LOCAL_ONLY = "1";
  try {
    assert.throws(
      () => manager.setBrainSettings({ type: "openai_compatible", baseUrl: "https://api.openai.com/v1" }),
      /Local-only mode is on .*remote AI at api\.openai\.com/,
    );
    assert.equal(store.getBrainSettings().type, "local");
    manager.setBrainSettings({ type: "openai_compatible", baseUrl: "http://192.168.1.20:11434/v1" });
    assert.equal(store.getBrainSettings().baseUrl, "http://192.168.1.20:11434/v1");
  } finally {
    if (prior === undefined) delete process.env.MANA_LOCAL_ONLY;
    else process.env.MANA_LOCAL_ONLY = prior;
  }
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

test("testBrainConnection trims trailing slashes from baseUrl without a regex", async () => {
  const manager = createModelManagement({
    env: {},
    localGgufs: [],
    modelSettingsStore: fakeModelSettingsStore(),
  });
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    assert.equal(String(url), "http://127.0.0.1:11434/v1/models");
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  };
  try {
    const result = await manager.testBrainConnection({
      baseUrl: "http://127.0.0.1:11434/v1///",
    });
    assert.equal(result.ok, true);
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

// Fakes nvidia-smi (missing unless given) and the two `reg query` calls.
function fakeGpuSpawn({ smi = null, driverDesc = "", qwMemorySize = "" } = {}) {
  return (bin, args) => {
    if (bin === "nvidia-smi") {
      return smi ? { status: 0, stdout: smi } : { error: new Error("ENOENT"), status: null };
    }
    const out = args.includes("DriverDesc") ? driverDesc : qwMemorySize;
    return out ? { status: 0, stdout: `\r\n${out}\r\nEnd of search: 1 match(es) found.\r\n` } : { status: 1, stdout: "" };
  };
}
const CLASS = "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}";

test("detectGpu: nvidia-smi first, with name, VRAM and CUDA", () => {
  const gpu = detectGpu({ spawnSync: fakeGpuSpawn({ smi: "NVIDIA GeForce RTX 5080, 16303\n" }), platform: "win32" });
  assert.deepEqual(gpu, { vendor: "nvidia", name: "NVIDIA GeForce RTX 5080", vramMb: 16303, cuda: true, sharedMemory: false });
});

test("detectGpu: without nvidia-smi, reads 64-bit VRAM and name from the display adapter registry keys", () => {
  const spawnSync = fakeGpuSpawn({
    driverDesc:
      `${CLASS}\\0000\r\n    DriverDesc    REG_SZ    AMD Radeon(TM) Graphics\r\n\r\n` +
      `${CLASS}\\0001\r\n    DriverDesc    REG_SZ    AMD Radeon RX 7900 XTX\r\n\r\n` +
      `${CLASS}\\0002\r\n    DriverDesc    REG_SZ    Microsoft Basic Display Adapter`,
    qwMemorySize:
      `${CLASS}\\0000\r\n    HardwareInformation.qwMemorySize    REG_QWORD    0x20000000\r\n\r\n` +
      `${CLASS}\\0001\r\n    HardwareInformation.qwMemorySize    REG_QWORD    0x600000000`,
  });
  // 24 GB -- past the 4 GB WMI AdapterRAM cap; the APU is skipped for it.
  assert.deepEqual(detectGpu({ spawnSync, platform: "win32" }), {
    vendor: "amd", name: "AMD Radeon RX 7900 XTX", vramMb: 24576, cuda: false, sharedMemory: false,
  });
});

test("detectGpu: an integrated GPU is flagged as shared memory, not counted as VRAM", () => {
  const spawnSync = fakeGpuSpawn({
    driverDesc: `${CLASS}\\0000\r\n    DriverDesc    REG_SZ    Intel(R) Iris(R) Xe Graphics`,
    qwMemorySize: `${CLASS}\\0000\r\n    HardwareInformation.qwMemorySize    REG_QWORD    0x80000000`,
  });
  assert.deepEqual(detectGpu({ spawnSync, platform: "win32" }), {
    vendor: "intel", name: "Intel(R) Iris(R) Xe Graphics", vramMb: null, cuda: false, sharedMemory: true,
  });
});

test("detectGpu: null when nothing is found, off Windows without nvidia-smi, or on a throw", () => {
  assert.equal(detectGpu({ spawnSync: fakeGpuSpawn(), platform: "win32" }), null);
  assert.equal(detectGpu({ spawnSync: fakeGpuSpawn({ driverDesc: `${CLASS}\\0000\r\n    DriverDesc    REG_SZ    AMD Radeon RX 6600` }), platform: "linux" }), null);
  assert.equal(detectGpu({ spawnSync: () => { throw new Error("boom"); }, platform: "win32" }), null);
});

test("detectGpuVramUsageMb parses used/free nvidia-smi output and returns null on failure", () => {
  assert.deepEqual(
    detectGpuVramUsageMb(() => ({ status: 0, stdout: "1024, 5120\n" })),
    { usedMb: 1024, freeMb: 5120 },
  );

  assert.equal(detectGpuVramUsageMb(() => ({ status: 1, stdout: "" })), null);
  assert.equal(detectGpuVramUsageMb(() => ({ status: 0, stdout: "" })), null);
  assert.equal(
    detectGpuVramUsageMb(() => ({ status: 0, stdout: "not-a-number, 5120\n" })),
    null,
  );
  assert.equal(
    detectGpuVramUsageMb(() => {
      throw new Error("nvidia-smi not found");
    }),
    null,
  );
  assert.equal(
    detectGpuVramUsageMb(() => ({ error: new Error("ENOENT"), status: null })),
    null,
  );
});

test("getModelStatus caches live VRAM usage within a short TTL, re-checks after it expires", () => {
  let usageCalls = 0;
  let clock = 0;
  const manager = createModelManagement({
    env: {},
    localGgufs: [],
    spawnSync: (command, args) => {
      if (args.some((arg) => arg.includes("memory.total"))) {
        return { status: 0, stdout: "6144\n" };
      }
      usageCalls += 1;
      return { status: 0, stdout: `${usageCalls * 100}, 5000\n` };
    },
    totalmem: () => 34_359_738_368,
    modelSettingsStore: fakeModelSettingsStore(),
    now: () => clock,
  });

  assert.equal(manager.getModelStatus().vramUsedMb, 100);
  assert.equal(manager.getModelStatus().vramUsedMb, 100, "still cached within the TTL window");
  assert.equal(usageCalls, 1);

  clock += 2001;
  assert.equal(manager.getModelStatus().vramUsedMb, 200, "re-checked after the TTL expired");
  assert.equal(usageCalls, 2);
});

test("getModelStatus caches a failed VRAM usage detection too, not just a successful one", () => {
  let usageCalls = 0;
  let clock = 0;
  const manager = createModelManagement({
    env: {},
    localGgufs: [],
    spawnSync: (command, args) => {
      if (args.some((arg) => arg.includes("memory.total"))) {
        return { status: 0, stdout: "6144\n" };
      }
      // nvidia-smi failing (e.g. no NVIDIA GPU) -- detectGpuVramUsageMb
      // returns null for this, not a value to cache.
      usageCalls += 1;
      return { status: 1, stdout: "" };
    },
    totalmem: () => 34_359_738_368,
    modelSettingsStore: fakeModelSettingsStore(),
    now: () => clock,
  });

  assert.equal(manager.getModelStatus().vramUsedMb, null);
  assert.equal(manager.getModelStatus().vramFreeMb, null);
  assert.equal(usageCalls, 1, "a failed detection should be cached too, not re-spawned every call");

  clock += 2001;
  manager.getModelStatus();
  assert.equal(usageCalls, 2, "re-checked after the TTL expired, same as a successful detection would be");
});

test("detectSystemMemoryMb converts bytes to whole megabytes", () => {
  assert.equal(detectSystemMemoryMb(() => 34_359_738_368), 32768);
  assert.equal(detectSystemMemoryMb(() => 0), null);
  assert.equal(detectSystemMemoryMb(() => NaN), null);
});

test("recommendModelProfile picks a tier from the VRAM left for the LLM", () => {
  assert.equal(recommendModelProfile({ vramMb: 4096, ramMb: 65536 }).profile, "fast");
  assert.equal(recommendModelProfile({ vramMb: 6144, ramMb: 65536 }).profile, "default");
  assert.equal(recommendModelProfile({ vramMb: 8188, ramMb: 65536 }).profile, "default");
  assert.equal(recommendModelProfile({ vramMb: 12288, ramMb: 8192 }).profile, "quality");
  assert.match(recommendModelProfile({ vramMb: 6144, ramMb: null }).reason, /nvidia-smi/i);
});

test("recommendModelProfile subtracts TTS and Whisper VRAM first (#1086)", () => {
  // 8GB with Fish on: ~3GB left, so fast.
  const tight = recommendModelProfile({ vramMb: 8188, ramMb: 32768, voiceMb: 5120 + 273 });
  assert.equal(tight.profile, "fast");
  assert.match(tight.reason, /~5\.3GB of it held by TTS and Whisper, leaving ~2\.7GB for the LLM/);
  // A 16GB card keeps quality next to Fish and a medium Whisper model.
  assert.equal(recommendModelProfile({ vramMb: 16303, ramMb: 32768, voiceMb: 5120 + 2150 }).profile, "quality");
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
  let capacityCalls = 0;
  let usageCalls = 0;
  const manager = createModelManagement({
    env: {},
    localGgufs: [],
    // Issue #320: detectGpuVramMb (capacity, "memory.total") and
    // detectGpuVramUsageMb (live usage, "memory.used,memory.free") share
    // this same spawnSync in production -- distinguish by the query flag,
    // same as the real nvidia-smi calls this mock stands in for.
    spawnSync: (command, args) => {
      if (args.some((arg) => arg.includes("memory.total"))) {
        capacityCalls += 1;
        return { status: 0, stdout: "6144\n" };
      }
      usageCalls += 1;
      return { status: 0, stdout: "1024, 5120\n" };
    },
    totalmem: () => 34_359_738_368,
    modelSettingsStore: fakeModelSettingsStore(),
    // #1086: Fish (5GB) + whisper tiny leave under 1GB of the 6GB.
    ttsProvider: "fish",
    whisperModel: path.join("C:", "whisper", "ggml-tiny.en.bin"),
  });

  const first = manager.getRecommendedModelProfile();
  assert.equal(first.profile, "fast");
  assert.match(first.reason, /~5\.3GB of it held by TTS and Whisper/);
  assert.equal(first.label, "Fast fallback");
  assert.deepEqual(first.detected, { vramMb: 6144, ramMb: 32768 });

  manager.getRecommendedModelProfile();
  const status = manager.getModelStatus();
  assert.equal(capacityCalls, 1, "hardware detection should be cached, not re-run per call");
  assert.equal(usageCalls, 1, "live VRAM usage should spawn once for this getModelStatus call");
  assert.equal(status.vramUsedMb, 1024);
  assert.equal(status.vramFreeMb, 5120);

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

test("estimateModelFit labels a model against VRAM, then VRAM + half of RAM", () => {
  const gb = 1024 ** 3;
  // 5GB file -> ~6GB footprint with the 1.2 margin.
  assert.equal(estimateModelFit({ sizeBytes: 5 * gb, vramMb: 8192, ramMb: 16384 }), "fits");
  assert.equal(estimateModelFit({ sizeBytes: 5 * gb, vramMb: 4096, ramMb: 16384 }), "slow");
  assert.equal(estimateModelFit({ sizeBytes: 20 * gb, vramMb: 4096, ramMb: 16384 }), "wont_fit");
  // No NVIDIA GPU detected: never "fits", RAM-only is at best slow.
  assert.equal(estimateModelFit({ sizeBytes: 1 * gb, vramMb: null, ramMb: 16384 }), "slow");
  assert.equal(estimateModelFit({ sizeBytes: 10 * gb, vramMb: null, ramMb: 16384 }), "wont_fit");
  // Unknown size or unknown hardware: no label rather than a guess.
  assert.equal(estimateModelFit({ sizeBytes: null, vramMb: 8192, ramMb: 16384 }), null);
  assert.equal(estimateModelFit({ sizeBytes: 0, vramMb: 8192, ramMb: 16384 }), null);
  assert.equal(estimateModelFit({ sizeBytes: 5 * gb, vramMb: null, ramMb: null }), null);
});

test("scanForModels attaches a fit label per file from the detected hardware", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mana-model-fit-"));
  const mb = 1024 * 1024;
  // Tiny fake hardware (1MB VRAM, 4MB RAM) so real-sized files aren't needed.
  fs.writeFileSync(path.join(root, "small.gguf"), Buffer.alloc(100));
  fs.writeFileSync(path.join(root, "medium.gguf"), Buffer.alloc(2 * mb));
  fs.writeFileSync(path.join(root, "large.gguf"), Buffer.alloc(5 * mb));
  const manager = createModelManagement({
    env: {},
    localGgufs: [],
    spawnSync: () => ({ status: 0, stdout: "1\n" }),
    totalmem: () => 4 * mb,
    modelSettingsStore: fakeModelSettingsStore(),
  });

  try {
    const fits = Object.fromEntries(
      manager.scanForModels([root]).found.map((m) => [m.name, m.fit]),
    );
    assert.deepEqual(fits, { "small.gguf": "fits", "medium.gguf": "slow", "large.gguf": "wont_fit" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loadIntoVram: on by default in /models/status, saved via setLoadIntoVram, non-booleans rejected", () => {
  const manager = createModelManagement({
    env: {},
    localGgufs: [],
    spawnSync: () => ({ status: 1, stdout: "" }),
    modelSettingsStore: fakeModelSettingsStore(),
  });
  assert.equal(manager.getModelStatus().loadIntoVram, true);
  assert.equal(manager.setLoadIntoVram(false).loadIntoVram, false);
  assert.throws(() => manager.setLoadIntoVram("false"), /loadIntoVram must be true or false/);
  assert.equal(manager.getModelStatus().loadIntoVram, false);
});
