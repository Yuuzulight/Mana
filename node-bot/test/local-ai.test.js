const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  findPreferredLlamaModel,
  getKnownLlamaModelProfiles,
  normalizeLlamaModelProfile,
  pickPreferredLlamaModel,
  selectLlamaModelProfileForPrompt,
  shouldUseRemoteAi,
} = require("../ai/local-ai");

test("local AI module keeps remote AI disabled unless explicitly allowed", () => {
  assert.equal(
    shouldUseRemoteAi({
      apiKey: "present",
      allowRemoteAi: "",
    }),
    false,
  );
  assert.equal(
    shouldUseRemoteAi({
      apiKey: "present",
      allowRemoteAi: "0",
    }),
    false,
  );
  assert.equal(
    shouldUseRemoteAi({
      apiKey: "present",
      allowRemoteAi: "1",
    }),
    true,
  );
});

test("shouldUseRemoteAi exempts local/LAN OpenAI-compatible endpoints from the consent gate", () => {
  // No API key, no opt-in flag -- still true, because the endpoint is local.
  assert.equal(
    shouldUseRemoteAi({
      apiKey: null,
      allowRemoteAi: "",
      baseUrl: "http://127.0.0.1:11434/v1",
    }),
    true,
  );
  assert.equal(
    shouldUseRemoteAi({
      apiKey: null,
      allowRemoteAi: "",
      baseUrl: "http://localhost:1234/v1",
    }),
    true,
  );
  assert.equal(
    shouldUseRemoteAi({
      apiKey: null,
      allowRemoteAi: "",
      baseUrl: "http://192.168.1.50:8000/v1",
    }),
    true,
  );
  // A genuinely remote host still needs the full consent gate.
  assert.equal(
    shouldUseRemoteAi({
      apiKey: null,
      allowRemoteAi: "",
      baseUrl: "https://api.openai.com",
    }),
    false,
  );
  assert.equal(
    shouldUseRemoteAi({
      apiKey: "sk-test",
      allowRemoteAi: "1",
      baseUrl: "https://openrouter.ai/api/v1",
    }),
    true,
  );
});

test("local AI module selects preferred default and coding models", () => {
  const root = path.join("C:", "ManaAI", "Mana", "tools", "llama", "gguf-models");
  const models = [
    path.join(root, "Qwen3-8B-Q4_K_M.gguf"),
    path.join(root, "Qwen3-4B-Q4_K_M.gguf"),
    path.join(root, "qwen2.5-coder-7b-instruct-q4_k_m.gguf"),
  ];

  assert.equal(
    pickPreferredLlamaModel({ localGgufs: models, profile: "default" }),
    path.join(root, "Qwen3-4B-Q4_K_M.gguf"),
  );
  assert.equal(
    pickPreferredLlamaModel({ localGgufs: models, profile: "coding" }),
    path.join(root, "qwen2.5-coder-7b-instruct-q4_k_m.gguf"),
  );
});

test("local AI module can discover preferred models from a search directory", () => {
  const modelPath = findPreferredLlamaModel({
    searchDir: path.join(__dirname, "missing-model-dir"),
    localGgufs: [
      path.join("C:", "models", "Qwen3-8B-Q4_K_M.gguf"),
      path.join("C:", "models", "Qwen3-4B-Q4_K_M.gguf"),
    ],
  });

  assert.equal(modelPath, path.join("C:", "models", "Qwen3-4B-Q4_K_M.gguf"));
});

test("local AI module exposes known profiles including fast fallback", () => {
  assert.deepEqual(getKnownLlamaModelProfiles(), [
    "default",
    "fast",
    "quality",
    "coding",
  ]);
  assert.equal(normalizeLlamaModelProfile("FAST"), "fast");
});

test("local AI module routes coding prompts to the coding profile", () => {
  assert.equal(normalizeLlamaModelProfile("unknown"), "default");
  assert.equal(selectLlamaModelProfileForPrompt("please debug this node.js test"), "coding");
  assert.equal(selectLlamaModelProfileForPrompt("use 8b mode for a deeper answer"), "quality");
  assert.equal(
    selectLlamaModelProfileForPrompt("normal chat", "coding"),
    "coding",
  );
});
