// Issue #76: watches a folder for dropped files (notes, images, audio) and
// ingests their content into acpMemoryStore as background memory -- no chat
// turn is user-visible, this is a passive drop-and-forget inbox.
//
// Uses Node's native fs.watch (Windows has always supported this; Mana is
// Windows-only) rather than a chokidar dependency -- the issue's proposed
// scope named chokidar only as an example, and stdlib covers exactly what's
// needed here.
const fs = require("node:fs");
const path = require("node:path");

const TEXT_EXTENSIONS = new Set([".txt", ".md"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".ogg", ".flac"]);

// Every ingested entry lands in one dedicated pseudo-session that no chat UI
// ever opens, rather than a real conversation session -- reuses the entire
// existing acpMemoryStore/appendTurn/buildPromptMemory pipeline for free
// while staying out of any visible session chat log.
const MEMORY_INBOX_SESSION_ID = "memory-inbox";

// ponytail: fixed settle window, not a real "still growing" check across
// multiple writers -- good enough for the single-writer drag-and-drop/copy
// case this is built for. Bump if real usage sees half-written ingests.
const DEFAULT_SETTLE_MS = 1000;

function extOf(filePath) {
  return path.extname(filePath).toLowerCase();
}

async function isSettled(filePath, fsImpl, settleMs, sleep) {
  try {
    const before = fsImpl.statSync(filePath);
    await sleep(settleMs);
    const after = fsImpl.statSync(filePath);
    return before.size === after.size && before.mtimeMs === after.mtimeMs;
  } catch (e) {
    // Disappeared mid-check (still being copied via a temp-file swap, or
    // already processed by a previous event) -- treat as not settled yet.
    return false;
  }
}

async function extractFileText(filePath, { runVisionReply, runWhisper, fsImpl }) {
  const ext = extOf(filePath);
  if (TEXT_EXTENSIONS.has(ext)) {
    return fsImpl.readFileSync(filePath, "utf8");
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    const image = fsImpl.readFileSync(filePath).toString("base64");
    return runVisionReply(
      "Describe what you see in this image in detail, including any visible text.",
      [image],
    );
  }
  if (AUDIO_EXTENSIONS.has(ext)) {
    return runWhisper(filePath);
  }
  return null; // unsupported extension -- silently skipped, not an error
}

// options.appendTurn: required, acpMemoryStore.appendTurn-shaped function.
// options.runVisionReply: required, (prompt, images) => Promise<string>.
// options.runWhisper: required, (filePath) => string (whisper.cpp is sync).
function createMemoryInboxWatcher(options = {}) {
  const inboxDir = options.inboxDir;
  if (!inboxDir) {
    throw new Error("inboxDir is required");
  }
  const processedDir = path.join(inboxDir, "processed");
  const appendTurn = options.appendTurn;
  const runVisionReply = options.runVisionReply;
  const runWhisper = options.runWhisper;
  const fsImpl = options.fs || fs;
  const watchFn = options.watch || fs.watch;
  const sleep = options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const settleMs = Number(options.settleMs || DEFAULT_SETTLE_MS);
  const onError = options.onError || ((err, filePath) => {
    console.warn(
      `Memory inbox: failed to ingest ${filePath}:`,
      err && err.message ? err.message : err,
    );
  });
  // In-flight guard so overlapping fs events for the same file (Windows
  // commonly fires several "change" events per write) don't double-process.
  const pending = new Set();

  fsImpl.mkdirSync(inboxDir, { recursive: true });
  fsImpl.mkdirSync(processedDir, { recursive: true });

  async function handleFile(filePath) {
    if (pending.has(filePath)) return;
    pending.add(filePath);
    try {
      if (!fsImpl.existsSync(filePath)) return;
      if (!(await isSettled(filePath, fsImpl, settleMs, sleep))) return;
      const text = await extractFileText(filePath, {
        runVisionReply,
        runWhisper,
        fsImpl,
      });
      if (text && String(text).trim()) {
        await appendTurn({
          sessionId: MEMORY_INBOX_SESSION_ID,
          user: String(text).trim(),
          assistant: "",
        });
      }
      // Moved out of the watched dir on success so it can't be re-ingested
      // by a later unrelated fs event, and so "processed/" is a visible
      // record of what actually made it into memory.
      fsImpl.renameSync(filePath, path.join(processedDir, path.basename(filePath)));
    } catch (e) {
      onError(e, filePath);
    } finally {
      pending.delete(filePath);
    }
  }

  // Returns the handleFile() promise (real fs.watch ignores it) so tests
  // can capture the callback and await it directly instead of racing it.
  const watcher = watchFn(inboxDir, (eventType, filename) => {
    if (!filename) return undefined;
    const filePath = path.join(inboxDir, filename);
    return handleFile(filePath).catch((e) => onError(e, filePath));
  });

  return {
    close: () => watcher.close(),
    inboxDir,
    processedDir,
  };
}

module.exports = {
  createMemoryInboxWatcher,
  extractFileText,
  MEMORY_INBOX_SESSION_ID,
  TEXT_EXTENSIONS,
  IMAGE_EXTENSIONS,
  AUDIO_EXTENSIONS,
};
