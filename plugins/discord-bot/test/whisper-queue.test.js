const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createWhisperQueue } = require("../whisper-queue");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-whisper-queue-"));
}

// A fake spawn() -- a child_process.spawn-shaped EventEmitter with
// stdout/stderr sub-emitters. handler decides how each invocation behaves;
// tracks concurrency so tests can assert the queue never runs two at once.
function createFakeSpawn({ handler, activeCounter }) {
  return function fakeSpawn(bin, args) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    if (activeCounter) activeCounter.active += 1;
    setImmediate(async () => {
      try {
        await handler({ child, bin, args });
      } finally {
        if (activeCounter) activeCounter.active -= 1;
      }
    });
    return child;
  };
}

test("transcribe resolves with the transcript from whisper-cli's JSON output file", async () => {
  const dir = createTempDir();
  const wavPath = path.join(dir, "utterance.wav");
  fs.writeFileSync(wavPath, "fake wav");

  const spawnImpl = createFakeSpawn({
    handler: async ({ child, args }) => {
      const ofIndex = args.indexOf("-of");
      const outBase = args[ofIndex + 1];
      fs.writeFileSync(`${outBase}.json`, JSON.stringify({ transcription: [{ text: "hello" }, { text: "there" }] }));
      child.emit("close", 0);
    },
  });

  const queue = createWhisperQueue({ whisperBin: "whisper-cli.exe", whisperModel: "model.bin", spawnImpl });
  const result = await queue.transcribe(wavPath);
  assert.equal(result, "hello there");
});

test("transcribe rejects when whisper-cli exits non-zero", async () => {
  const dir = createTempDir();
  const wavPath = path.join(dir, "utterance.wav");
  const spawnImpl = createFakeSpawn({
    handler: async ({ child }) => {
      child.stderr.emit("data", "boom");
      child.emit("close", 1);
    },
  });

  const queue = createWhisperQueue({ whisperBin: "whisper-cli.exe", whisperModel: "model.bin", spawnImpl });
  await assert.rejects(() => queue.transcribe(wavPath), /whisper failed \(exit 1\)/);
});

test("transcribe falls back to stdout when no JSON output file appears", async () => {
  const dir = createTempDir();
  const wavPath = path.join(dir, "utterance.wav");
  const spawnImpl = createFakeSpawn({
    handler: async ({ child }) => {
      child.stdout.emit("data", "raw stdout transcript");
      child.emit("close", 0);
    },
  });

  const queue = createWhisperQueue({ whisperBin: "whisper-cli.exe", whisperModel: "model.bin", spawnImpl });
  const result = await queue.transcribe(wavPath);
  assert.equal(result, "raw stdout transcript");
});

test("concurrent transcribe() calls are serialized -- never more than one whisper-cli process at a time", async () => {
  const dir = createTempDir();
  const activeCounter = { active: 0 };
  let maxConcurrent = 0;
  const spawnImpl = createFakeSpawn({
    activeCounter,
    handler: async ({ child, args }) => {
      maxConcurrent = Math.max(maxConcurrent, activeCounter.active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const ofIndex = args.indexOf("-of");
      const outBase = args[ofIndex + 1];
      fs.writeFileSync(`${outBase}.json`, JSON.stringify({ transcription: [{ text: "done" }] }));
      child.emit("close", 0);
    },
  });

  const queue = createWhisperQueue({ whisperBin: "whisper-cli.exe", whisperModel: "model.bin", spawnImpl });
  const [a, b, c] = await Promise.all([
    queue.transcribe(path.join(dir, "a.wav")),
    queue.transcribe(path.join(dir, "b.wav")),
    queue.transcribe(path.join(dir, "c.wav")),
  ]);
  assert.deepEqual([a, b, c], ["done", "done", "done"]);
  assert.equal(maxConcurrent, 1);
});

test("a failed transcription does not wedge the queue for subsequent calls", async () => {
  const dir = createTempDir();
  let callCount = 0;
  const spawnImpl = createFakeSpawn({
    handler: async ({ child }) => {
      callCount += 1;
      if (callCount === 1) {
        child.emit("close", 1);
      } else {
        child.emit("close", 0);
      }
    },
  });

  const queue = createWhisperQueue({ whisperBin: "whisper-cli.exe", whisperModel: "model.bin", spawnImpl });
  await assert.rejects(() => queue.transcribe(path.join(dir, "a.wav")));
  const result = await queue.transcribe(path.join(dir, "b.wav"));
  assert.equal(result, ""); // no JSON file written, empty stdout -- still resolves, doesn't hang
});

test("createWhisperQueue requires whisperBin and whisperModel", () => {
  assert.throws(() => createWhisperQueue({ whisperModel: "model.bin" }), /whisperBin is required/);
  assert.throws(() => createWhisperQueue({ whisperBin: "whisper-cli.exe" }), /whisperModel is required/);
});
