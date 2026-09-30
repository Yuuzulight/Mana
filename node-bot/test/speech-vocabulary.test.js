// #923/#925/#926: saved speech words, mishearing fixes and language, and
// the speech__* tools. Temp dirs only; no whisper.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  correctTranscript,
  createSpeechVocabulary,
  mayBeOrdinaryWord,
  resolveWhisperLanguage,
} = require("../speech-vocabulary");
const { createSpeechToolSource } = require("../ai/speech-tool-source");

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mana-speech-")), "data", "speech.json");
}

test("corrections replace whole words and phrases, any case, longest first, in one pass (#925)", () => {
  const fixes = { "GG Moon": "Gigi Murin", GG: "Gigi", Onesan: "Oneesan", "Gigi Murin": "wrong" };
  assert.equal(correctTranscript("I watched gg  moon with GG today", fixes), "I watched Gigi Murin with Gigi today");
  // Not inside other words; a fix isn't fixed again by another entry.
  assert.equal(correctTranscript("GGs and eggmoon, Onesan's here", fixes), "GGs and eggmoon, Oneesan's here");
  assert.equal(correctTranscript("HoloLive virtual youth table", { "HoloLive virtual youth table": "Hololive VTuber" }), "Hololive VTuber");
  assert.equal(correctTranscript("C.Rain", { "C.Rain": "Claude" }), "Claude");
  assert.equal(correctTranscript("CxRain", { "C.Rain": "Claude" }), "CxRain", "a dot is literal");
  assert.equal(correctTranscript("", fixes), "");
  assert.equal(correctTranscript("hi", {}), "hi");
});

test("a single ordinary-looking word needs confirm; phrases and jargon-shaped words don't (#925)", () => {
  assert.equal(mayBeOrdinaryWord("Immortal"), true);
  assert.equal(mayBeOrdinaryWord("immortal"), true);
  assert.equal(mayBeOrdinaryWord("GG Moon"), false);
  assert.equal(mayBeOrdinaryWord("GGMorin"), false);
  assert.equal(mayBeOrdinaryWord("CloudRain"), false);
});

test("words, corrections and language persist, dedupe and clean (#923/#925/#926)", () => {
  const filePath = tempFile();
  const vocab = createSpeechVocabulary({ filePath });
  assert.equal(vocab.addWord(" Gigi  Murin! "), "Gigi Murin");
  vocab.addWord("gigi murin");
  vocab.addWord("Oneesan");
  assert.throws(() => vocab.addWord("<>"), /word must be/);
  assert.throws(() => vocab.addCorrection("Immortal", "Imouto"), (e) => e.needsConfirm === true);
  vocab.addCorrection("Immortal", "Imouto", { confirm: true });
  vocab.addCorrection("GG Moon", "Gigi Murin");
  vocab.addCorrection("gg moon", "Gigi Murin");
  assert.throws(() => vocab.addCorrection("Gigi", "gigi"), /same/);
  vocab.setLanguage("auto");
  assert.throws(() => vocab.setLanguage("fr"), /language must be/);

  const reloaded = createSpeechVocabulary({ filePath });
  assert.deepEqual(reloaded.state(), {
    words: ["Gigi Murin", "Oneesan"],
    corrections: { Immortal: "Imouto", "gg moon": "Gigi Murin" },
    language: "auto",
  });
  assert.equal(reloaded.correct("hi GG Moon"), "hi Gigi Murin");

  // Removing a word drops fixes from or to it.
  assert.equal(reloaded.removeWord("GIGI MURIN"), true);
  assert.equal(reloaded.removeWord("nope"), false);
  assert.equal(reloaded.removeCorrection("immortal"), true);
  assert.deepEqual(createSpeechVocabulary({ filePath }).state(), { words: ["Oneesan"], corrections: {}, language: "auto" });
});

test("a broken hand edit is never overwritten (#923)", () => {
  const filePath = tempFile();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "{ words: [oops");
  const { warn } = console;
  console.warn = () => {};
  try {
    const vocab = createSpeechVocabulary({ filePath });
    assert.deepEqual(vocab.words(), []);
    assert.throws(() => vocab.addWord("Gigi"), /fix or delete it/);
    assert.deepEqual(vocab.words(), []);
  } finally {
    console.warn = warn;
  }
  assert.equal(fs.readFileSync(filePath, "utf8"), "{ words: [oops");
});

test("WHISPER_LANGUAGE wins, then the saved choice, English by default (#926)", () => {
  assert.equal(resolveWhisperLanguage(undefined, "en"), "en");
  assert.equal(resolveWhisperLanguage("", "auto"), "auto");
  assert.equal(resolveWhisperLanguage("ja", "auto"), "ja");
  assert.equal(resolveWhisperLanguage(undefined, "bogus"), "en");
});

test("speech__ tools add, fix, list and remove only what the user said (#923/#925)", async () => {
  const speechVocabulary = createSpeechVocabulary({ filePath: tempFile() });
  const tools = (userMessage) => createSpeechToolSource({ speechVocabulary, userMessage });
  const call = async (userMessage, name, args) => JSON.parse(await tools(userMessage).executeTool(`speech__${name}`, args));

  assert.deepEqual(await call("add Gigi Murin to your words", "add_word", { word: "Gigi Murin" }), { ok: true, word: "Gigi Murin" });
  assert.equal((await call("add Gigi to your words", "add_word", { word: "Evil Neuro" })).ok, false);
  assert.equal((await call("add GigiMurin", "add_word", { word: "Gigi" })).ok, false, "whole words only");

  const said = "I said Gigi Murin, not GG Moon";
  assert.deepEqual(await call(said, "add_word", { word: "Gigi Murin", heard_as: "GG Moon" }), {
    ok: true,
    word: "Gigi Murin",
    heard_as: "GG Moon",
  });
  const ordinary = await call("it's Imouto, not immortal", "add_word", { word: "Imouto", heard_as: "immortal" });
  assert.equal(ordinary.needsConfirm, true);
  assert.match(ordinary.error, /only if they insist/);
  assert.equal((await call("yes, Imouto not immortal", "add_word", { word: "Imouto", heard_as: "immortal", confirm: true })).ok, true);

  assert.deepEqual(await call("", "list_words", {}), {
    words: ["Gigi Murin", "Imouto"],
    corrections: { "GG Moon": "Gigi Murin", immortal: "Imouto" },
  });
  assert.deepEqual(await call("forget Imouto", "remove_word", { word: "Imouto" }), { ok: true, removed: true });
  assert.deepEqual(speechVocabulary.state().corrections, { "GG Moon": "Gigi Murin" });
  await assert.rejects(tools("").executeTool("speech__nope", {}), /unknown speech tool/);
});
