// #1107: a new mishearing fix corrects my kept voice clips' sidecars (the
// native launcher writes them). Temp dirs only.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { applyCorrectionToClips, voiceDataDir, DEFAULT_VOICE_DATA_DIR } = require("../voice-data");
const { createSpeechVocabulary } = require("../speech-vocabulary");

function clipsDir(clips) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-voice-data-"));
  fs.mkdirSync(path.join(dir, "turns"));
  for (const [name, clip] of Object.entries(clips)) {
    fs.writeFileSync(path.join(dir, "turns", `${name}.json`), JSON.stringify(clip));
  }
  return dir;
}
const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, "turns", `${name}.json`), "utf8"));

test("a mishearing fix fills in corrected on the clips that have it, and only those", async () => {
  const dir = clipsDir({
    a: { heard: "watch gg moon now", transcript: "watch gg moon now", corrected: null, durationSec: 1.5 },
    b: { heard: "hi Mana", transcript: "hi Mana", corrected: null },
    c: { heard: "gg moon and GG Moon", transcript: "gg moon and Gigi Moon", corrected: "GG moon and Gigi Moon" },
    // The fix itself, said aloud: which "GG Moon" was misheard is anyone's guess.
    d: { heard: "I said Gigi Murin, not GG Moon", transcript: "I said Gigi Murin, not GG Moon", corrected: null },
  });
  fs.writeFileSync(path.join(dir, "turns", "a.wav"), "RIFF");

  assert.equal(await applyCorrectionToClips(dir, "GG Moon", "Gigi Murin"), 2);
  assert.deepEqual(read(dir, "a"), { heard: "watch gg moon now", transcript: "watch gg moon now", corrected: "watch Gigi Murin now", durationSec: 1.5 });
  assert.equal(read(dir, "b").corrected, null);
  // An earlier correction is built on, not replaced.
  assert.equal(read(dir, "c").corrected, "Gigi Murin and Gigi Moon");
  assert.equal(read(dir, "d").corrected, null);
});

test("no clips folder, or a broken sidecar, changes nothing and doesn't throw", async () => {
  assert.equal(await applyCorrectionToClips(path.join(os.tmpdir(), "mana-no-such-dir"), "GG Moon", "Gigi Murin"), 0);
  const dir = clipsDir({ ok: { transcript: "GG Moon" } });
  fs.writeFileSync(path.join(dir, "turns", "broken.json"), "{");
  assert.equal(await applyCorrectionToClips(dir, "GG Moon", "Gigi Murin"), 1);
});

test("the folder is MANA_VOICE_DATA_DIR, else D:\\ManaAI\\voice-data", () => {
  assert.equal(voiceDataDir({ MANA_VOICE_DATA_DIR: "E:\\voice" }), "E:\\voice");
  assert.equal(voiceDataDir({}), DEFAULT_VOICE_DATA_DIR);
});

test("saving a mishearing fix calls onCorrection with what was saved", () => {
  const seen = [];
  const vocab = createSpeechVocabulary({
    filePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mana-speech-")), "speech.json"),
    onCorrection: (fix) => seen.push(fix),
  });
  vocab.addCorrection(" GG  Moon ", "Gigi Murin");
  assert.throws(() => vocab.addCorrection("immortal", "Imouto"), /ordinary word/);
  assert.deepEqual(seen, [{ heard: "GG Moon", term: "Gigi Murin" }]);
});
