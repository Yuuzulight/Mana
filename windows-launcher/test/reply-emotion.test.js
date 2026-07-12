const assert = require("node:assert/strict");
const test = require("node:test");

const {
  detectReplyEmotion,
  detectTextMood,
  moodToState,
} = require("../renderer/reply-emotion");

test("detectTextMood reads Mana's own smiling kaomojis", () => {
  assert.equal(detectTextMood("Hey there! (´▽｀)"), "smile");
  assert.equal(detectTextMood("Sure thing (￣▽￣)"), "smile");
  assert.equal(detectTextMood("(＾▽＾) let's do it"), "smile");
});

test("detectTextMood reads sad/angry kaomojis", () => {
  assert.equal(detectTextMood("I miss you (T_T)"), "sniff");
  assert.equal(detectTextMood("Hmph! (＃｀´)"), "grr");
  assert.equal(detectTextMood("(>_<) that hurt"), "ow");
});

test("detectTextMood reads flat/unimpressed eyes as disgust, not a smile", () => {
  assert.equal(detectTextMood("(-_-) really?"), "disgust");
  assert.equal(detectTextMood("that's gross (-.-)"), "disgust");
  assert.equal(detectTextMood("(=_=) no thanks"), "disgust");
});

test("detectTextMood ignores ordinary parentheticals", () => {
  assert.equal(detectTextMood("Sure (see the docs) sounds good"), null);
  assert.equal(detectTextMood("no kaomoji or emoji here at all"), null);
});

test("detectTextMood reads emoji as a fallback signal", () => {
  assert.equal(detectTextMood("That's wonderful 😊"), "smile");
  assert.equal(detectTextMood("I'm so mad right now 😠"), "grr");
  assert.equal(detectTextMood("aww 🥺"), "sniff");
});

test("detectTextMood prefers kaomoji over emoji when both are present", () => {
  assert.equal(detectTextMood("(T_T) even though 😊"), "sniff");
});

test("moodToState maps moods to avatar states, ambiguous moods stay neutral", () => {
  assert.equal(moodToState("smile"), "excited");
  assert.equal(moodToState("sniff"), "sad");
  assert.equal(moodToState("grr"), "angry");
  assert.equal(moodToState("disgust"), "disgusted");
  assert.equal(moodToState("hmm"), "talking");
  assert.equal(moodToState("nonexistent-mood"), null);
});

test("detectReplyEmotion uses kaomoji/emoji mood before word patterns", () => {
  assert.equal(detectReplyEmotion("The sun is shining today! (´▽｀)"), "excited");
  assert.equal(detectReplyEmotion("(T_T) I'm sorry that happened"), "sad");
  assert.equal(detectReplyEmotion("Hmph! (＃｀´)"), "angry");
  assert.equal(detectReplyEmotion("(-_-) that's gross"), "disgusted");
});

test("detectReplyEmotion falls back to English mood words with no kaomoji/emoji", () => {
  assert.equal(detectReplyEmotion("Yay!! Let's go!"), "excited");
  assert.equal(detectReplyEmotion("Ugh, stop that, seriously"), "angry");
  assert.equal(detectReplyEmotion("Ew, that's so gross and disgusting."), "disgusted");
  assert.equal(detectReplyEmotion("The weather looks calm today."), "talking");
});
