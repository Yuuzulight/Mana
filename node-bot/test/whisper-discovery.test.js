const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { findWhisperBin, findWhisperModel } = require("../whisper-discovery");

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
