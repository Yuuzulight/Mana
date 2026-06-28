const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  normalizeLlamaModelProfile,
  pickPreferredLlamaModel,
  selectLlamaModelProfileForPrompt,
} = require("../server");

function touch(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "model");
}

test("findPreferredLlamaModel prefers explicit env model over local tiers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mana-models-"));
  const explicitModel = path.join(root, "custom.gguf");
  const primaryModel = path.join(root, "Qwen3-4B-Q4_K_M.gguf");

  try {
    touch(explicitModel);
    touch(primaryModel);

    assert.equal(
      pickPreferredLlamaModel({
        explicitModel,
        localGgufs: [primaryModel],
      }),
      explicitModel,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findPreferredLlamaModel uses 4B primary before 1.5B and 8B backups", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mana-models-"));
  const onePointFiveB = path.join(root, "qwen2.5-1.5b-instruct-q4_k_m.gguf");
  const fourB = path.join(root, "Qwen3-4B-Q4_K_M.gguf");
  const eightB = path.join(root, "Qwen3-8B-Q4_K_M.gguf");

  try {
    touch(onePointFiveB);
    touch(eightB);
    touch(fourB);

    assert.equal(
      pickPreferredLlamaModel({
        explicitModel: "",
        localGgufs: [onePointFiveB, eightB, fourB],
      }),
      fourB,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findPreferredLlamaModel falls back to 1.5B before 8B when 4B is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mana-models-"));
  const onePointFiveB = path.join(root, "qwen2.5-1.5b-instruct-q4_k_m.gguf");
  const eightB = path.join(root, "Qwen3-8B-Q4_K_M.gguf");

  try {
    touch(eightB);
    touch(onePointFiveB);

    assert.equal(
      pickPreferredLlamaModel({
        explicitModel: "",
        localGgufs: [eightB, onePointFiveB],
      }),
      onePointFiveB,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findPreferredLlamaModel uses coder model for coding profile", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mana-models-"));
  const fourB = path.join(root, "Qwen3-4B-Q4_K_M.gguf");
  const coder = path.join(root, "qwen2.5-coder-7b-instruct-q4_k_m.gguf");
  const eightB = path.join(root, "Qwen3-8B-Q4_K_M.gguf");

  try {
    touch(fourB);
    touch(eightB);
    touch(coder);

    assert.equal(
      pickPreferredLlamaModel({
        explicitModel: "",
        localGgufs: [fourB, eightB, coder],
        profile: "coding",
      }),
      coder,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findPreferredLlamaModel lets non-default profiles ignore the default explicit model", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mana-models-"));
  const fourB = path.join(root, "Qwen3-4B-Q4_K_M.gguf");
  const coder = path.join(root, "qwen2.5-coder-7b-instruct-q4_k_m.gguf");

  try {
    touch(fourB);
    touch(coder);

    assert.equal(
      pickPreferredLlamaModel({
        explicitModel: fourB,
        localGgufs: [fourB, coder],
        profile: "coding",
      }),
      coder,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findPreferredLlamaModel uses 8B model for quality profile", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mana-models-"));
  const onePointFiveB = path.join(root, "qwen2.5-1.5b-instruct-q4_k_m.gguf");
  const fourB = path.join(root, "Qwen3-4B-Q4_K_M.gguf");
  const eightB = path.join(root, "Qwen3-8B-Q4_K_M.gguf");

  try {
    touch(onePointFiveB);
    touch(fourB);
    touch(eightB);

    assert.equal(
      pickPreferredLlamaModel({
        explicitModel: "",
        localGgufs: [onePointFiveB, fourB, eightB],
        profile: "quality",
      }),
      eightB,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findPreferredLlamaModel falls back to local 4B when local coder GGUF is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mana-models-"));
  const fourB = path.join(root, "Qwen3-4B-Q4_K_M.gguf");

  try {
    touch(fourB);

    assert.equal(
      pickPreferredLlamaModel({
        explicitModel: "",
        localGgufs: [fourB],
        profile: "coding",
      }),
      fourB,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("normalizeLlamaModelProfile only accepts known profiles", () => {
  assert.equal(normalizeLlamaModelProfile("coding"), "coding");
  assert.equal(normalizeLlamaModelProfile("QUALITY"), "quality");
  assert.equal(normalizeLlamaModelProfile("unknown"), "default");
});

test("selectLlamaModelProfileForPrompt routes coding requests to coding profile", () => {
  assert.equal(
    selectLlamaModelProfileForPrompt("Can you debug this JavaScript function?"),
    "coding",
  );
});

test("selectLlamaModelProfileForPrompt routes explicit quality requests to quality profile", () => {
  assert.equal(
    selectLlamaModelProfileForPrompt("Use quality mode and give me a deeper answer."),
    "quality",
  );
});

test("selectLlamaModelProfileForPrompt honors explicit valid profile over prompt text", () => {
  assert.equal(
    selectLlamaModelProfileForPrompt("Can you debug this function?", "default"),
    "default",
  );
});
