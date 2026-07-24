// Decides which avatar state a reply should trigger. Mana places kaomojis
// and emoji in nearly every reply and picks them deliberately, so they're
// the clearest emotional signal she gives — check those before falling back
// to a small set of English mood words for replies that have neither.
// (Mirrors the mood taxonomy in node-bot/utils/speech-text.js, which uses
// the same signals to choose what she *says* aloud for an emoji/kaomoji.)
//
// Wrapped in an IIFE so its top-level declarations don't leak into the
// shared global scope classic scripts otherwise all share -- see
// avatar/live2d-logic.js for why that matters.
(function () {

const EMOJI_MOODS = [
  [/[\u{1F60A}\u{1F642}\u{1F604}\u{1F600}\u{1F601}\u{263A}\u{1F638}]/gu, "smile"],
  [/[\u{1F606}\u{1F923}\u{1F602}]/gu, "haha"],
  [/[\u{1F609}\u{1F61C}\u{1F61D}\u{1F92A}]/gu, "wink"],
  [/\u{1F605}/gu, "phew"],
  [
    /[\u{1F970}\u{1F60D}\u{1F496}\u{1F495}\u{1F497}\u{1F493}\u{2764}\u{1F9E1}\u{1F49B}\u{1F49A}\u{1F499}\u{1F49C}\u{1F90D}\u{1F5A4}\u{2763}\u{2665}]/gu,
    "heart",
  ],
  [/[\u{1F622}\u{1F62D}\u{1F97A}\u{1F63F}]/gu, "sniff"],
  [/[\u{1F620}\u{1F621}\u{1F4A2}]/gu, "grr"],
  [/[\u{1F922}\u{1F92E}\u{1F612}]/gu, "disgust"],
  [/[\u{1F62E}\u{1F632}\u{1F633}]/gu, "gasp"],
  [/\u{1F914}/gu, "hmm"],
  [/[\u{1F634}\u{1F4A4}]/gu, "yawn"],
  [/[\u{2728}\u{1F31F}\u{2B50}]/gu, "sparkle"],
  [/[\u{1F389}\u{1F38A}\u{1F973}]/gu, "yay"],
  [/\u{1F44D}/gu, "thumbs up"],
  [/\u{1F44B}/gu, "wave"],
];

// A short parenthesized cluster, optionally with "arm" characters outside,
// e.g. (＾▽＾), (T_T), ヽ(´▽`)ノ, ¯\_(ツ)_/¯.
const KAOMOJI_PATTERN =
  /(?:[¯ヽ٩ᕕoO\\/]\s?[\\_]{0,2})?[（(][^（）()\s]{1,18}[)）](?:[_]{0,2}[\\/]?[¯ノ۶ᕗoO]?)?/gu;

const KAOMOJI_MOODS = [
  { pattern: /[TТ╥;уД]_|_[TТ╥;]|;;|℃゜|(?:゜|｡)(?:\.|,)/u, word: "sniff" },
  { pattern: /[＃#╬凸]/u, word: "grr" },
  { pattern: /｀[^´]*´/u, word: "hmph" },
  { pattern: /><|>[_.]</u, word: "ow" },
  { pattern: /[♡♥❤]/u, word: "heart" },
  { pattern: /ツ/u, word: "shrug" },
  // Flat/dead "unimpressed" eyes read as disgust, not a smile — must be
  // checked before the smile catch-all below (it shares the "-" glyph).
  { pattern: /-_-|-\.-|=_=|・_・/u, word: "disgust" },
  { pattern: /[＾^▽‿ᴗ◕●•ω≧≦￣´｀°˘‾-]/u, word: "smile" },
];

// A parenthesized span only counts as a kaomoji when it contains face-like
// symbols; "(really)" and "(see docs)" must never match.
const KAOMOJI_FACE_CHARS =
  /[＾▽‿ᴗω◕●•｀´≧≦￣ДツТ°｡♡♥❤╥＃#╬><;~＿=]|^[（(][TtoOxXuUnNmMwWvV_.;'"~^=-]+[)）]$/u;

function kaomojiMood(face) {
  if (!KAOMOJI_FACE_CHARS.test(face)) {
    return null;
  }
  for (const mood of KAOMOJI_MOODS) {
    if (mood.pattern.test(face)) {
      return mood.word;
    }
  }
  return null;
}

// Scans the text for the first kaomoji or emoji mood signal, or null.
function detectTextMood(text) {
  const value = String(text || "");

  const kaomojiMatches = value.match(KAOMOJI_PATTERN) || [];
  for (const match of kaomojiMatches) {
    const mood = kaomojiMood(match);
    if (mood) {
      return mood;
    }
  }

  for (const [pattern, mood] of EMOJI_MOODS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) {
      return mood;
    }
  }

  return null;
}

// Positive/energetic moods read as "excited"; sniff/ow read as "sad";
// grr/hmph read as "angry"; disgust is its own state (see live2d-logic's
// "disgusted" preferences — this model shows it via a blank "white-eyes"
// expression). Anything ambiguous (thinking, relief, a shrug) is left as
// plain "talking" rather than guessing.
const MOOD_STATE = {
  smile: "excited",
  haha: "excited",
  wink: "excited",
  sparkle: "excited",
  yay: "excited",
  "thumbs up": "excited",
  wave: "excited",
  heart: "excited",
  gasp: "excited",
  sniff: "sad",
  ow: "sad",
  grr: "angry",
  hmph: "angry",
  disgust: "disgusted",
  hmm: "talking",
  yawn: "talking",
  shrug: "talking",
  phew: "talking",
};

function moodToState(mood) {
  return MOOD_STATE[mood] || null;
}

const EXCITED_WORDS =
  /!{2,}|\b(yay|yes|nice|great|awesome|amazing|let'?s go|finally|hehe|haha)\b/;
const ANGRY_WORDS =
  /\b(angry|mad|annoyed|ugh|hmph|stupid|idiot|seriously|how dare|stop that)\b/;
const DISGUST_WORDS =
  /\b(disgusting|disgusted|gross|grossed out|yuck+y?|ew+|nasty|revolting|repulsive|eww+)\b/;

function detectReplyEmotion(text) {
  const normalized = String(text || "");

  const moodState = moodToState(detectTextMood(normalized));
  if (moodState) {
    return moodState;
  }

  const lower = normalized.toLowerCase();
  if (DISGUST_WORDS.test(lower)) {
    return "disgusted";
  }
  if (ANGRY_WORDS.test(lower)) {
    return "angry";
  }
  if (EXCITED_WORDS.test(lower)) {
    return "excited";
  }
  return "talking";
}

const exportsObj = {
  detectReplyEmotion,
  detectTextMood,
  moodToState,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = exportsObj;
}
if (typeof window !== "undefined") {
  window.ManaReplyEmotion = exportsObj;
}

})();
