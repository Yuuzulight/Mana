const assert = require("node:assert/strict");
const test = require("node:test");

const {
  readGgufMetadata,
  computeParameterCount,
  quantizationLabel,
} = require("../tools/gguf-metadata");

function fakeGgufFn(result) {
  return async () => result;
}

test("readGgufMetadata extracts architecture, name, quantization, context length, param count", async () => {
  const result = await readGgufMetadata("fake.gguf", {
    ggufFn: fakeGgufFn({
      metadata: {
        "general.architecture": "llama",
        "general.name": "LLaMA v2",
        "general.file_type": 10,
        "llama.context_length": 4096,
        tensor_count: 3n,
      },
      tensorInfos: [
        { name: "a", shape: [4096n, 32000n] },
        { name: "b", shape: [4096n] },
        { name: "c", shape: [11008n, 4096n] },
      ],
    }),
  });

  assert.equal(result.architecture, "llama");
  assert.equal(result.name, "LLaMA v2");
  assert.equal(result.quantization, "MOSTLY_Q2_K");
  assert.equal(result.contextLength, 4096);
  assert.equal(result.tensorCount, 3);
  // 4096*32000 + 4096 + 11008*4096 = 131072000 + 4096 + 45088768 = 176164864
  assert.equal(result.parameterCount, "176164864");
});

test("readGgufMetadata handles a bigint context length", async () => {
  const result = await readGgufMetadata("fake.gguf", {
    ggufFn: fakeGgufFn({
      metadata: { "general.architecture": "qwen2", "qwen2.context_length": 32768n },
      tensorInfos: [],
    }),
  });
  assert.equal(result.contextLength, 32768);
  assert.equal(typeof result.contextLength, "number");
});

test("readGgufMetadata returns null fields gracefully when metadata is sparse", async () => {
  const result = await readGgufMetadata("fake.gguf", {
    ggufFn: fakeGgufFn({ metadata: {}, tensorInfos: [] }),
  });
  assert.equal(result.architecture, null);
  assert.equal(result.name, null);
  assert.equal(result.quantization, null);
  assert.equal(result.contextLength, null);
  assert.equal(result.parameterCount, null);
});

test("readGgufMetadata returns null (not throws) when the underlying parser fails", async () => {
  const result = await readGgufMetadata("not-a-real-file.gguf", {
    ggufFn: async () => {
      throw new Error("ENOENT: no such file");
    },
  });
  assert.equal(result, null);
});

test("computeParameterCount sums tensor shapes across all tensors", () => {
  const count = computeParameterCount([
    { shape: [2n, 3n] }, // 6
    { shape: [4n] }, // 4
  ]);
  assert.equal(count, 10n);
});

test("computeParameterCount returns null for empty/missing tensor info", () => {
  assert.equal(computeParameterCount([]), null);
  assert.equal(computeParameterCount(null), null);
  assert.equal(computeParameterCount([{ shape: [] }]), null);
});

test("quantizationLabel maps known file_type values, falls back for unknown ones", () => {
  assert.equal(quantizationLabel(15), "MOSTLY_Q4_K_M");
  assert.equal(quantizationLabel(999), "UNKNOWN_999");
  assert.equal(quantizationLabel(undefined), null);
});
