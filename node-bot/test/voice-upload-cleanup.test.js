const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createApp, sweepStaleTmpFiles } = require("../server");
const { withServer } = require("./helpers");

async function gone(files) {
  for (let i = 0; i < 50 && files.some((f) => fs.existsSync(f)); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return files.filter((f) => fs.existsSync(f));
}

test("a voice upload and whisper's files next to it are deleted even when the request fails", async () => {
  let written = [];
  const app = createApp({
    runWhisperHeard: async (audioPath) => {
      const upload = path.join(path.dirname(audioPath), path.basename(audioPath).split(".")[0]);
      const json = `${upload}.wav.out.json`;
      fs.writeFileSync(json, '{"transcription":[{"text":"my words"}]}');
      written = [upload, audioPath, json];
      throw new Error("whisper failed");
    },
  });

  await withServer(app, async (baseUrl) => {
    const form = new FormData();
    form.append("file", new Blob([Buffer.from("RIFF")]), "voice.wav");
    const response = await fetch(`${baseUrl}/transcribe-only`, { method: "POST", body: form });
    assert.equal(response.status, 500);
  });

  assert.equal(written.length, 3);
  assert.deepEqual(await gone(written), []);
});

test("the startup sweep deletes temp files over an hour old and leaves folders", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-tmp-sweep-"));
  const now = Date.now();
  const old = path.join(dir, "0123456789abcdef0123456789abcdef");
  const fresh = path.join(dir, "fedcba9876543210fedcba9876543210");
  fs.writeFileSync(old, "old voice");
  fs.writeFileSync(fresh, "new voice");
  fs.utimesSync(old, new Date(now - 2 * 60 * 60 * 1000), new Date(now - 2 * 60 * 60 * 1000));
  fs.mkdirSync(path.join(dir, "tesseract"));

  assert.equal(sweepStaleTmpFiles(dir, 60 * 60 * 1000, now), 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["fedcba9876543210fedcba9876543210", "tesseract"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
