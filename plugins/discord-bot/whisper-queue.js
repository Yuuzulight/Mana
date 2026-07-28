// Issue #187's "real risk": node-bot/server.js's runWhisper() is spawnSync
// -- fine for one HTTP request, a genuine problem for a voice channel where
// multiple people talking would each try to block the same event loop that
// serves every other node-bot route. This is a separate, async (spawn, not
// spawnSync) whisper invocation, serialized one-at-a-time through a FIFO
// queue rather than run concurrently -- whisper-cli is a single-shot CPU/GPU-
// bound process either way, so queuing (not parallelizing) is the correct
// fix, not just the easy one.
const fs = require("fs");
const { spawn } = require("child_process");

const DEFAULT_MAX_BUFFER = 50 * 1024 * 1024;

// options.spawnImpl: injectable for tests. options.whisperBin/whisperModel:
// resolved paths (same whisper-discovery.js helpers server.js's own
// runWhisper already uses). options.threads/language/beamSize/etc mirror
// server.js's existing WHISPER_* env-derived tuning.
function createWhisperQueue(options = {}) {
  const whisperBin = options.whisperBin;
  const whisperModel = options.whisperModel;
  const spawnImpl = options.spawnImpl || spawn;
  const threads = options.threads || "4";
  const language = options.language || "en";
  const beamSize = options.beamSize || "5";
  const noSpeechThreshold = options.noSpeechThreshold || "0.6";
  const temperature = options.temperature || "0";

  if (!whisperBin) throw new Error("whisperBin is required");
  if (!whisperModel) throw new Error("whisperModel is required");

  let queue = Promise.resolve();

  // Runs one whisper-cli invocation, async (spawn), and returns the
  // transcript -- same JSON-output-file contract server.js's own runWhisper
  // already uses (--output-json), just not blocking the event loop while
  // it runs.
  function runOnce(wavPath) {
    return new Promise((resolve, reject) => {
      const outBase = `${wavPath}.out`;
      const outJson = `${outBase}.json`;
      const args = [
        "-m",
        whisperModel,
        "-f",
        wavPath,
        "-t",
        String(threads),
        "-l",
        language,
        "-bs",
        String(beamSize),
        "-nth",
        String(noSpeechThreshold),
        "-tp",
        String(temperature),
        "--output-json",
        "-of",
        outBase,
      ];
      const child = spawnImpl(whisperBin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.length > DEFAULT_MAX_BUFFER) stdout = stdout.slice(-DEFAULT_MAX_BUFFER);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`whisper failed (exit ${code}): ${stderr.slice(0, 500)}`));
          return;
        }
        if (!fs.existsSync(outJson)) {
          resolve(stdout.trim());
          return;
        }
        try {
          const parsed = JSON.parse(fs.readFileSync(outJson, "utf8"));
          const text = Array.isArray(parsed.transcription)
            ? parsed.transcription
                .map((segment) => segment.text)
                .join(" ")
                .trim()
            : "";
          try {
            fs.unlinkSync(outJson);
          } catch (e) {}
          try {
            fs.unlinkSync(`${outBase}.txt`);
          } catch (e) {}
          resolve(text || stdout.trim());
        } catch (e) {
          resolve(stdout.trim());
        }
      });
    });
  }

  // Chains onto the existing queue rather than firing immediately -- the
  // whole point is "one whisper-cli process at a time," not "one per
  // caller, running concurrently."
  function transcribe(wavPath) {
    const result = queue.then(() => runOnce(wavPath));
    // Swallow the rejection on the queue chain itself so one failed
    // transcription doesn't permanently wedge the queue for every
    // subsequent caller -- the actual rejection still propagates to
    // whoever awaited this specific transcribe() call, via `result`.
    queue = result.catch(() => {});
    return result;
  }

  return { transcribe };
}

module.exports = { createWhisperQueue };
