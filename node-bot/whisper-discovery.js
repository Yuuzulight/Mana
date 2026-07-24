// Auto-detects the local whisper.cpp binary and model, the same way
// model-management.js/local-ai.js already auto-detect the llama binary and
// GGUF model -- WHISPER_BIN had its own inline candidate list in server.js,
// but WHISPER_MODEL had no auto-detection at all (a hard "set the env var
// or transcription is unavailable" requirement). Extracted into its own
// module so both server.js (the actual whisper-cli invocation) and
// doctor.js (status reporting) share one source of truth instead of
// server.js's fallback and doctor.js's "configured?" check silently
// disagreeing (see issue #123).
const path = require("node:path");
const { collectFilesRecursively } = require("./ai/local-ai");

function findWhisperBin(options = {}) {
  const env = options.env || process.env;
  const fs = options.fs || require("node:fs");
  const toolsDir =
    options.toolsDir || path.join(__dirname, "..", "tools", "whisper");

  const candidates = [];
  if (env.WHISPER_BIN) {
    candidates.push(env.WHISPER_BIN);
  }
  candidates.push(
    path.join(toolsDir, "Release", "whisper-cli.exe"),
    path.join(toolsDir, "whisper-cli.exe"),
    path.join(toolsDir, "main.exe"),
  );

  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

// whisper.cpp's own convention (ggml-<size>[.<lang>].bin, e.g.
// ggml-base.en.bin) -- preferred over an arbitrary first-match so the
// choice is deterministic and favors a reasonable default (per
// docs/quick_start_windows.md: base/small over tiny for accuracy) when more
// than one is present. Falls through to "first .bin found" for a model
// that doesn't follow the naming convention rather than finding nothing.
const PREFERRED_NAME_ORDER = [
  "ggml-base.en.bin",
  "ggml-base.bin",
  "ggml-small.en.bin",
  "ggml-small.bin",
  "ggml-tiny.en.bin",
  "ggml-tiny.bin",
  "ggml-medium.en.bin",
  "ggml-medium.bin",
  "ggml-large.bin",
];

function findWhisperModel(options = {}) {
  const env = options.env || process.env;
  const fs = options.fs || require("node:fs");
  const toolsDir =
    options.toolsDir || path.join(__dirname, "..", "tools", "whisper");

  // Same "explicit path if it actually exists, otherwise fall through to
  // auto-detection" behavior as findWhisperBin -- a stale/wrong
  // WHISPER_MODEL shouldn't hide a perfectly good auto-detected model that
  // exists right there under toolsDir.
  if (env.WHISPER_MODEL && fs.existsSync(env.WHISPER_MODEL)) {
    return env.WHISPER_MODEL;
  }

  const collect = options.collectFilesRecursively || collectFilesRecursively;
  const found = collect(toolsDir, (fullPath) =>
    fullPath.toLowerCase().endsWith(".bin"),
  );
  if (!found.length) {
    return null;
  }

  for (const preferredName of PREFERRED_NAME_ORDER) {
    const match = found.find(
      (fullPath) => path.basename(fullPath).toLowerCase() === preferredName,
    );
    if (match) {
      return match;
    }
  }
  return found[0];
}

module.exports = { findWhisperBin, findWhisperModel };
