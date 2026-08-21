const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  findWhisperBin,
  findWhisperModel,
  findParakeetBin,
  findParakeetModel,
} = require("../whisper-discovery");

function tempToolsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-whisper-discovery-"));
}

test("findWhisperBin prefers an explicit WHISPER_BIN when set", () => {
  const toolsDir = tempToolsDir();
  const explicit = path.join(toolsDir, "custom-whisper.exe");
  fs.writeFileSync(explicit, "");
  const found = findWhisperBin({ env: { WHISPER_BIN: explicit }, toolsDir });
  assert.equal(found, explicit);
});

test("findWhisperBin auto-detects Release/whisper-cli.exe when unset", () => {
  const toolsDir = tempToolsDir();
  fs.mkdirSync(path.join(toolsDir, "Release"), { recursive: true });
  const expected = path.join(toolsDir, "Release", "whisper-cli.exe");
  fs.writeFileSync(expected, "");
  const found = findWhisperBin({ env: {}, toolsDir });
  assert.equal(found, expected);
});

test("findWhisperBin returns null when nothing is found", () => {
  const toolsDir = tempToolsDir();
  assert.equal(findWhisperBin({ env: {}, toolsDir }), null);
});

test("findWhisperModel prefers an explicit WHISPER_MODEL when set and it exists", () => {
  const toolsDir = tempToolsDir();
  const explicit = path.join(toolsDir, "my-model.bin");
  fs.writeFileSync(explicit, "");
  const found = findWhisperModel({ env: { WHISPER_MODEL: explicit }, toolsDir });
  assert.equal(found, explicit);
});

test("findWhisperModel returns null for an explicit WHISPER_MODEL that doesn't exist and nothing to auto-detect", () => {
  const toolsDir = tempToolsDir();
  const found = findWhisperModel({
    env: { WHISPER_MODEL: path.join(toolsDir, "missing.bin") },
    toolsDir,
  });
  assert.equal(found, null);
});

test("findWhisperModel falls through to auto-detection when WHISPER_MODEL is set but wrong (a stale env var shouldn't hide a real model)", () => {
  const toolsDir = tempToolsDir();
  fs.mkdirSync(path.join(toolsDir, "models"), { recursive: true });
  const realModel = path.join(toolsDir, "models", "ggml-base.en.bin");
  fs.writeFileSync(realModel, "");
  const found = findWhisperModel({
    env: { WHISPER_MODEL: path.join(toolsDir, "stale-path.bin") },
    toolsDir,
  });
  assert.equal(found, realModel);
});

test("findWhisperModel auto-detects a model under a models/ subfolder (real-world layout)", () => {
  const toolsDir = tempToolsDir();
  fs.mkdirSync(path.join(toolsDir, "models"), { recursive: true });
  const expected = path.join(toolsDir, "models", "ggml-tiny.en.bin");
  fs.writeFileSync(expected, "");
  const found = findWhisperModel({ env: {}, toolsDir });
  assert.equal(found, expected);
});

test("findWhisperModel prefers ggml-base over ggml-tiny when both are present", () => {
  const toolsDir = tempToolsDir();
  fs.mkdirSync(path.join(toolsDir, "models"), { recursive: true });
  fs.writeFileSync(path.join(toolsDir, "models", "ggml-tiny.en.bin"), "");
  const preferred = path.join(toolsDir, "models", "ggml-base.en.bin");
  fs.writeFileSync(preferred, "");
  const found = findWhisperModel({ env: {}, toolsDir });
  assert.equal(found, preferred);
});

test("findWhisperModel falls back to the first .bin found for a non-standard filename", () => {
  const toolsDir = tempToolsDir();
  const found1 = path.join(toolsDir, "my-custom-model.bin");
  fs.writeFileSync(found1, "");
  const found = findWhisperModel({ env: {}, toolsDir });
  assert.equal(found, found1);
});

test("findWhisperModel returns null when nothing is found", () => {
  const toolsDir = tempToolsDir();
  assert.equal(findWhisperModel({ env: {}, toolsDir }), null);
});

test("findWhisperModel prefers the WHISPER_MODEL_PROFILE tier over the default preference order", () => {
  const toolsDir = tempToolsDir();
  fs.mkdirSync(path.join(toolsDir, "models"), { recursive: true });
  fs.writeFileSync(path.join(toolsDir, "models", "ggml-base.en.bin"), ""); // the usual default winner
  const tinyModel = path.join(toolsDir, "models", "ggml-tiny.en.bin");
  fs.writeFileSync(tinyModel, "");
  const found = findWhisperModel({ env: { WHISPER_MODEL_PROFILE: "tiny" }, toolsDir });
  assert.equal(found, tinyModel);
});

test("findWhisperModel is case-insensitive for WHISPER_MODEL_PROFILE", () => {
  const toolsDir = tempToolsDir();
  fs.mkdirSync(path.join(toolsDir, "models"), { recursive: true });
  const smallModel = path.join(toolsDir, "models", "ggml-small.en.bin");
  fs.writeFileSync(smallModel, "");
  const found = findWhisperModel({ env: { WHISPER_MODEL_PROFILE: "SMALL" }, toolsDir });
  assert.equal(found, smallModel);
});

test("findWhisperModel falls back to the normal preference order when the requested profile's files aren't present", () => {
  const toolsDir = tempToolsDir();
  fs.mkdirSync(path.join(toolsDir, "models"), { recursive: true });
  const baseModel = path.join(toolsDir, "models", "ggml-base.en.bin");
  fs.writeFileSync(baseModel, ""); // no medium model exists, so requesting it shouldn't come up empty
  const found = findWhisperModel({ env: { WHISPER_MODEL_PROFILE: "medium" }, toolsDir });
  assert.equal(found, baseModel);
});

test("findWhisperModel ignores an unrecognized WHISPER_MODEL_PROFILE value", () => {
  const toolsDir = tempToolsDir();
  fs.mkdirSync(path.join(toolsDir, "models"), { recursive: true });
  const baseModel = path.join(toolsDir, "models", "ggml-base.en.bin");
  fs.writeFileSync(baseModel, "");
  const found = findWhisperModel({ env: { WHISPER_MODEL_PROFILE: "xlarge" }, toolsDir });
  assert.equal(found, baseModel);
});

test("findWhisperModel selects the turbo profile's large-v3-turbo model", () => {
  const toolsDir = tempToolsDir();
  fs.mkdirSync(path.join(toolsDir, "models"), { recursive: true });
  fs.writeFileSync(path.join(toolsDir, "models", "ggml-base.en.bin"), ""); // the usual default winner
  const turboModel = path.join(toolsDir, "models", "ggml-large-v3-turbo.bin");
  fs.writeFileSync(turboModel, "");
  const found = findWhisperModel({ env: { WHISPER_MODEL_PROFILE: "turbo" }, toolsDir });
  assert.equal(found, turboModel);
});

test("findWhisperModel auto-detects large-v3-turbo via PREFERRED_NAME_ORDER even without an explicit profile", () => {
  const toolsDir = tempToolsDir();
  fs.mkdirSync(path.join(toolsDir, "models"), { recursive: true });
  // A file that matches nothing in PREFERRED_NAME_ORDER, staged alongside
  // the turbo model -- if large-v3-turbo isn't actually registered in
  // PREFERRED_NAME_ORDER, neither file matches anything and the result
  // falls back to whatever collectFilesRecursively happens to return
  // first (non-deterministic/coincidental), which wouldn't reliably catch
  // a regression. Registering it properly means the preference-order loop
  // matches the turbo file specifically, regardless of collection order.
  fs.writeFileSync(path.join(toolsDir, "models", "a-nonstandard-name.bin"), "");
  const turboModel = path.join(toolsDir, "models", "ggml-large-v3-turbo.bin");
  fs.writeFileSync(turboModel, "");
  const found = findWhisperModel({ env: {}, toolsDir });
  assert.equal(found, turboModel);
});

test("findParakeetBin prefers an explicit PARAKEET_BIN when set", () => {
  const toolsDir = tempToolsDir();
  const explicit = path.join(toolsDir, "custom-parakeet.exe");
  fs.writeFileSync(explicit, "");
  const found = findParakeetBin({ env: { PARAKEET_BIN: explicit }, toolsDir });
  assert.equal(found, explicit);
});

test("findParakeetBin auto-detects Release/parakeet-cli.exe when unset", () => {
  const toolsDir = tempToolsDir();
  fs.mkdirSync(path.join(toolsDir, "Release"), { recursive: true });
  const expected = path.join(toolsDir, "Release", "parakeet-cli.exe");
  fs.writeFileSync(expected, "");
  const found = findParakeetBin({ env: {}, toolsDir });
  assert.equal(found, expected);
});

test("findParakeetBin returns null when nothing is found", () => {
  const toolsDir = tempToolsDir();
  assert.equal(findParakeetBin({ env: {}, toolsDir }), null);
});

test("findParakeetModel prefers an explicit PARAKEET_MODEL when set and it exists", () => {
  const toolsDir = tempToolsDir();
  const explicit = path.join(toolsDir, "my-parakeet.bin");
  fs.writeFileSync(explicit, "");
  const found = findParakeetModel({ env: { PARAKEET_MODEL: explicit }, toolsDir });
  assert.equal(found, explicit);
});

test("findParakeetModel ignores non-parakeet .bin files under tools/whisper (no cross-talk with Whisper models)", () => {
  const toolsDir = tempToolsDir();
  fs.mkdirSync(path.join(toolsDir, "models"), { recursive: true });
  fs.writeFileSync(path.join(toolsDir, "models", "ggml-base.en.bin"), "");
  assert.equal(findParakeetModel({ env: {}, toolsDir }), null);
});

test("findParakeetModel prefers f16 over q4_k/q8_0 when multiple quants are present", () => {
  const toolsDir = tempToolsDir();
  fs.mkdirSync(path.join(toolsDir, "models"), { recursive: true });
  fs.writeFileSync(path.join(toolsDir, "models", "ggml-parakeet-tdt-0.6b-v3-q4_k.bin"), "");
  fs.writeFileSync(path.join(toolsDir, "models", "ggml-parakeet-tdt-0.6b-v3-q8_0.bin"), "");
  const preferred = path.join(toolsDir, "models", "ggml-parakeet-tdt-0.6b-v3-f16.bin");
  fs.writeFileSync(preferred, "");
  const found = findParakeetModel({ env: {}, toolsDir });
  assert.equal(found, preferred);
});

test("findParakeetModel returns null when nothing is found", () => {
  const toolsDir = tempToolsDir();
  assert.equal(findParakeetModel({ env: {}, toolsDir }), null);
});
