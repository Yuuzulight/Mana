const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  createModelManagement,
  detectGpuVramMb,
  detectSystemMemoryMb,
  recommendModelProfile,
} = require("../model-management");

test("model management reports available and missing profile candidates", () => {
  const root = path.join("C:", "ManaAI", "Mana", "tools", "llama", "gguf-models");
  const fourB = path.join(root, "Qwen3-4B-Q4_K_M.gguf");
  const onePointFiveB = path.join(root, "qwen2.5-1.5b-instruct-q4_k_m.gguf");
  const manager = createModelManagement({
    env: {},
    localGgufs: [fourB, onePointFiveB],
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
  });

  assert.equal(manager.getModelStatus().profiles.quality.selectedModel, fourteenB);
});

test("model management switches active profile and rejects unknown profiles", () => {
  const manager = createModelManagement({ env: {}, localGgufs: [] });

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
  });

  const status = manager.getModelStatus();

  assert.equal(status.remoteAiEnabled, true);
  assert.match(status.remoteAiWarning, /Remote AI is enabled/i);
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
