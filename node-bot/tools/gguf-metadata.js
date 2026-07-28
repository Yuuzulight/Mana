// Issue #196: model-management.js's isValidGgufFile() only checks the
// 4-byte "GGUF" magic bytes (issue #125's security hardening) -- enough to
// reject a truncated/mislabeled file before handing it to llama-server, but
// it never reads the actual header. @huggingface/gguf parses the real GGUF
// key-value metadata + tensor shapes, letting the hardware-aware model
// recommender and the UI show real architecture/context-length/quant/param
// info instead of just a filename.
//
// Deliberately separate from the magic-byte check: that check stays the
// fast, cheap first-pass gate (model-management.js's isValidGgufFile is
// still called first, unchanged); this module is a slower, best-effort
// enrichment step layered on top, never a hard requirement for a model to
// be usable.

// Common general.file_type values (ggml_ftype in llama.cpp) mapped to their
// familiar quant names -- not exhaustive, just the common ones a user is
// likely to actually have downloaded. Falls back to a raw numeric label for
// anything not in this table rather than guessing.
const FILE_TYPE_NAMES = {
  0: "ALL_F32",
  1: "MOSTLY_F16",
  2: "MOSTLY_Q4_0",
  3: "MOSTLY_Q4_1",
  7: "MOSTLY_Q8_0",
  8: "MOSTLY_Q5_0",
  9: "MOSTLY_Q5_1",
  10: "MOSTLY_Q2_K",
  11: "MOSTLY_Q3_K_S",
  12: "MOSTLY_Q3_K_M",
  13: "MOSTLY_Q3_K_L",
  14: "MOSTLY_Q4_K_S",
  15: "MOSTLY_Q4_K_M",
  16: "MOSTLY_Q5_K_S",
  17: "MOSTLY_Q5_K_M",
  18: "MOSTLY_Q6_K",
  24: "MOSTLY_IQ2_XXS",
  32: "MOSTLY_BF16",
};

function quantizationLabel(fileType) {
  if (typeof fileType !== "number") return null;
  return FILE_TYPE_NAMES[fileType] || `UNKNOWN_${fileType}`;
}

// Total parameter count isn't a direct metadata field -- it's the standard
// sum-of-tensor-shapes computation (same approach llama.cpp's own
// gguf-dump.py uses), summed across every tensor in the file.
function computeParameterCount(tensorInfos) {
  if (!Array.isArray(tensorInfos)) return null;
  let total = 0n;
  for (const tensor of tensorInfos) {
    if (!Array.isArray(tensor?.shape) || !tensor.shape.length) continue;
    total += tensor.shape.reduce((acc, dim) => acc * BigInt(dim), 1n);
  }
  return total > 0n ? total : null;
}

// Returns null on any failure (missing file, unreadable, unsupported
// architecture key lookup) rather than throwing -- this is enrichment, not
// a requirement, and a parse failure must never block model selection.
async function readGgufMetadata(filePath, options = {}) {
  const ggufFn = options.ggufFn || require("@huggingface/gguf").gguf;
  try {
    const { metadata, tensorInfos } = await ggufFn(filePath, { allowLocalFile: true });
    const architecture = metadata["general.architecture"] || null;
    const contextLength = architecture ? metadata[`${architecture}.context_length`] ?? null : null;
    const parameterCount = computeParameterCount(tensorInfos);
    return {
      architecture,
      name: metadata["general.name"] || null,
      quantization: quantizationLabel(metadata["general.file_type"]),
      contextLength: typeof contextLength === "bigint" ? Number(contextLength) : contextLength,
      parameterCount: parameterCount === null ? null : parameterCount.toString(),
      tensorCount: typeof metadata.tensor_count === "bigint" ? Number(metadata.tensor_count) : metadata.tensor_count ?? null,
    };
  } catch (e) {
    return null;
  }
}

module.exports = { readGgufMetadata, computeParameterCount, quantizationLabel, FILE_TYPE_NAMES };
