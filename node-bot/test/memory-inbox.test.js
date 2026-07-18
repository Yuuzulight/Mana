const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createMemoryInboxWatcher,
  MEMORY_INBOX_SESSION_ID,
} = require("../memory-inbox");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-memory-inbox-"));
}

// Real fs, real temp dir (matches acp-memory-store.test.js's convention) --
// only `watch` (to trigger events manually instead of racing real fs.watch
// timing) and `sleep` (to make the settle-check instant) are faked.
function setupWatcher(overrides = {}) {
  const inboxDir = createTempDir();
  let capturedCallback = null;
  const appendCalls = [];

  const watcher = createMemoryInboxWatcher({
    inboxDir,
    appendTurn: async (input) => {
      appendCalls.push(input);
    },
    runVisionReply: async () => "a description of the image",
    runWhisper: () => "a transcript of the audio",
    watch: (dir, cb) => {
      capturedCallback = cb;
      return { close: () => {} };
    },
    sleep: async () => {},
    onError: (err) => {
      throw err; // surface unexpected failures instead of silently swallowing in tests
    },
    ...overrides,
  });

  return {
    inboxDir,
    processedDir: watcher.processedDir,
    appendCalls,
    trigger: (filename) => capturedCallback("change", filename),
  };
}

test("ingests a dropped text file and moves it to processed/", async () => {
  const { inboxDir, processedDir, appendCalls, trigger } = setupWatcher();
  const filePath = path.join(inboxDir, "note.txt");
  fs.writeFileSync(filePath, "Remember to buy milk.");

  await trigger("note.txt");

  assert.equal(appendCalls.length, 1);
  assert.equal(appendCalls[0].sessionId, MEMORY_INBOX_SESSION_ID);
  assert.equal(appendCalls[0].user, "Remember to buy milk.");
  assert.equal(appendCalls[0].assistant, "");
  assert.ok(!fs.existsSync(filePath), "original file should be moved out");
  assert.ok(fs.existsSync(path.join(processedDir, "note.txt")));
});

test("routes an image file through runVisionReply", async () => {
  let capturedImages = null;
  const { inboxDir, appendCalls, trigger } = setupWatcher({
    runVisionReply: async (prompt, images) => {
      capturedImages = images;
      return "a photo of a cat";
    },
  });
  const filePath = path.join(inboxDir, "photo.png");
  fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  await trigger("photo.png");

  assert.equal(appendCalls[0].user, "a photo of a cat");
  assert.equal(capturedImages.length, 1);
});

test("routes an audio file through runWhisper", async () => {
  let capturedPath = null;
  const { inboxDir, appendCalls, trigger } = setupWatcher({
    runWhisper: (filePath) => {
      capturedPath = filePath;
      return "hello from the recording";
    },
  });
  const filePath = path.join(inboxDir, "memo.wav");
  fs.writeFileSync(filePath, "fake audio bytes");

  await trigger("memo.wav");

  assert.equal(appendCalls[0].user, "hello from the recording");
  assert.equal(capturedPath, filePath);
});

test("skips ingestion for an unsupported extension but still clears it out of the inbox", async () => {
  const { inboxDir, processedDir, appendCalls, trigger } = setupWatcher();
  const filePath = path.join(inboxDir, "archive.zip");
  fs.writeFileSync(filePath, "not really a zip");

  await trigger("archive.zip");

  assert.equal(appendCalls.length, 0);
  assert.ok(fs.existsSync(path.join(processedDir, "archive.zip")));
});

test("does not ingest a file that isn't settled yet (still being written)", async () => {
  const { inboxDir, appendCalls, trigger } = setupWatcher({
    // Simulate the size changing between the two settle-check stats.
    sleep: async () => {
      fs.appendFileSync(path.join(inboxDir, "growing.txt"), "more content");
    },
  });
  fs.writeFileSync(path.join(inboxDir, "growing.txt"), "partial");

  await trigger("growing.txt");

  assert.equal(appendCalls.length, 0);
  assert.ok(fs.existsSync(path.join(inboxDir, "growing.txt")), "left in place for a later event to retry");
});

test("ignores an event for a file that's already gone (renamed/deleted before handling)", async () => {
  const { appendCalls, trigger } = setupWatcher();

  await trigger("never-existed.txt");

  assert.equal(appendCalls.length, 0);
});
