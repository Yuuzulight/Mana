const assert = require("node:assert/strict");
const test = require("node:test");

const { normalizeSpeechText } = require("../utils/speech-text");

test("known emojis become short spoken words", () => {
  assert.equal(normalizeSpeechText("Hello! 😊"), "Hello! smile");
  assert.equal(normalizeSpeechText("You got this! ✨"), "You got this! sparkle");
  assert.equal(normalizeSpeechText("Love it ❤️"), "Love it heart");
  assert.equal(normalizeSpeechText("Let me think 🤔 about it"), "Let me think hmm about it");
});

test("unmapped emojis are dropped instead of being read out", () => {
  assert.equal(normalizeSpeechText("Dinner time 🍜 yay"), "Dinner time yay");
  assert.equal(normalizeSpeechText("🦑"), "");
});

test("kaomojis become short spoken words", () => {
  assert.equal(normalizeSpeechText("Good morning! (＾▽＾)"), "Good morning! smile");
  assert.equal(normalizeSpeechText("That hurts (T_T)"), "That hurts sniff");
  assert.equal(normalizeSpeechText("Take that! (｀・ω・´)"), "Take that! humph");
  assert.equal(normalizeSpeechText("Whatever ¯\\_(ツ)_/¯"), "Whatever shrug");
  assert.equal(normalizeSpeechText("Ouch (>_<)"), "Ouch ow");
});

test("ordinary parentheticals are left alone", () => {
  assert.equal(
    normalizeSpeechText("The craft (level 90) sells well (probably)."),
    "The craft (level 90) sells well (probably).",
  );
  assert.equal(normalizeSpeechText("see docs (readme)"), "see docs (readme)");
});

test("skin tones and variation selectors do not leak into speech", () => {
  assert.equal(normalizeSpeechText("nice 👍🏻 work"), "nice thumbs up work");
});

test("vowel-less interjections become pronounceable words", () => {
  assert.equal(normalizeSpeechText("Hmph! Fine, I'll help."), "humph! Fine, I'll help.");
  assert.equal(normalizeSpeechText("Take that! (｀・ω・´)"), "Take that! humph");
  assert.equal(normalizeSpeechText("Grr, that mob again"), "argh, that mob again");
  assert.equal(normalizeSpeechText("Tsk tsk, sloppy rotation"), "tut tut, sloppy rotation");
  assert.equal(normalizeSpeechText("Shhh, secret"), "shush, secret");
  assert.equal(normalizeSpeechText("Zzzz... five more minutes"), "snooze... five more minutes");
});

test("words containing those letter runs are not mangled", () => {
  assert.equal(normalizeSpeechText("that run was grrreat"), "that run was grrreat");
  assert.equal(normalizeSpeechText("blizzard buzz pizzazz"), "blizzard buzz pizzazz");
  assert.equal(normalizeSpeechText("The programme ran"), "The programme ran");
});

test("trailing tildes stretch the last vowel instead of being narrated", () => {
  assert.equal(
    normalizeSpeechText("I don't think so,~"),
    "I don't think sooooo,",
  );
  assert.equal(normalizeSpeechText("Nya~"), "Nyaaaaa");
  assert.equal(normalizeSpeechText("Welcome back~!"), "Welcome baaaaack!");
  // more tildes stretch further
  assert.equal(normalizeSpeechText("so~~~"), "sooooooo");
  // consonant endings keep their tail
  assert.equal(normalizeSpeechText("Let's think~"), "Let's thiiiiink");
  // detached tildes just vanish from speech
  assert.equal(normalizeSpeechText("Well ~ anyway"), "Well anyway");
});

test("a plain thinking hmm is not turned into humph", () => {
  assert.equal(normalizeSpeechText("Hmm, let me check."), "Hmm, let me check.");
  assert.equal(normalizeSpeechText("Hmph, fine."), "humph, fine.");
});

test("empty and plain text pass through unchanged", () => {
  assert.equal(normalizeSpeechText(""), "");
  assert.equal(normalizeSpeechText("Just a normal sentence."), "Just a normal sentence.");
});
