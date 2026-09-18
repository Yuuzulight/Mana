const assert = require("node:assert/strict");
const test = require("node:test");

const { normalizeSpeechText, applyPronunciationLexicon } = require("../utils/speech-text");

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

test("fenced code blocks become a short spoken placeholder instead of being read symbol-by-symbol", () => {
  assert.equal(
    normalizeSpeechText("Here's the fix:\n```js\nfunction add(a, b) { return a + b; }\n```\nThat should work."),
    "Here's the fix: code block That should work.",
  );
});

test("a fenced code block with a language tag is still fully replaced", () => {
  assert.equal(
    normalizeSpeechText("```python\nprint('hi')\n```"),
    "code block",
  );
});

test("multiple fenced code blocks in one reply each become their own placeholder", () => {
  assert.equal(
    normalizeSpeechText("First:\n```\na()\n```\nThen:\n```\nb()\n```\nDone."),
    "First: code block Then: code block Done.",
  );
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

test("normalizeSpeechText applies user-registered pronunciation-lexicon overrides", () => {
  const entries = [{ word: "Qwen", replacement: "kwen" }];
  assert.equal(normalizeSpeechText("I'm running Qwen locally.", entries), "I'm running kwen locally.");
});

test("normalizeSpeechText with no lexicon entries behaves exactly as before", () => {
  assert.equal(normalizeSpeechText("Hmph! Qwen said hi."), "humph! Qwen said hi.");
  assert.equal(normalizeSpeechText("Hmph! Qwen said hi.", []), "humph! Qwen said hi.");
  assert.equal(normalizeSpeechText("Hmph! Qwen said hi.", undefined), "humph! Qwen said hi.");
});

test("applyPronunciationLexicon matches whole words only, case-insensitively", () => {
  const entries = [{ word: "Qwen", replacement: "kwen" }];
  assert.equal(applyPronunciationLexicon("QWEN and qwen and Qwen", entries), "kwen and kwen and kwen");
  assert.equal(applyPronunciationLexicon("Qwentin said hi", entries), "Qwentin said hi");
});

test("applyPronunciationLexicon replaces every original occurrence exactly once, even when one entry's replacement is another entry's word (no chaining)", () => {
  const entries = [
    { word: "Qwen", replacement: "kwen" },
    { word: "kwen", replacement: "kevin" },
  ];
  assert.equal(applyPronunciationLexicon("Qwen said hi, kwen too", entries), "kwen said hi, kevin too");
});

test("applyPronunciationLexicon treats a user's replacement text as literal, not a $-replacement pattern", () => {
  const entries = [{ word: "cost", replacement: "price is $&" }];
  assert.equal(applyPronunciationLexicon("the cost is high", entries), "the price is $& is high");
});

test("applyPronunciationLexicon with no matching entries returns the text unchanged", () => {
  const entries = [{ word: "Qwen", replacement: "kwen" }];
  assert.equal(applyPronunciationLexicon("nothing to see here", entries), "nothing to see here");
});

test("applyPronunciationLexicon with no entries returns the text unchanged", () => {
  assert.equal(applyPronunciationLexicon("Qwen said hi", []), "Qwen said hi");
  assert.equal(applyPronunciationLexicon("Qwen said hi", undefined), "Qwen said hi");
});
