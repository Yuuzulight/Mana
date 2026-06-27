const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { pickPreferredLlamaModel } = require("../server");

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
