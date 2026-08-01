// Issue #295 (piece 2 of #285): a server-side port of
// windows-launcher/renderer/reply-emotion.js's mood detection, reused for
// userAffectState rather than reinvented -- same emoji/kaomoji/keyword
// signal the avatar's expression already keys off, just consumed for a
// different purpose (a decaying affect score instead of a single reply's
// expression). windows-launcher and desktop-client already each keep their
// own copy of this file rather than sharing one across apps/processes, so
// a third copy here for node-bot (a separate backend process, no existing
// cross-app module boundary) matches that precedent instead of introducing
// a new one.
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

const KAOMOJI_PATTERN =
  /(?:[¯ヽ٩ᕕoO\\/]\s?[\\_]{0,2})?[（(][^（）()\s]{1,18}[)）](?:[_]{0,2}[\\/]?[¯ノ۶ᕗoO]?)?/gu;

const KAOMOJI_MOODS = [
  { pattern: /[TТ╥;уД]_|_[TТ╥;]|;;|℃゜|(?:゜|｡)(?:\.|,)/u, word: "sniff" },
  { pattern: /[＃#╬凸]/u, word: "grr" },
  { pattern: /｀[^´]*´/u, word: "hmph" },
  { pattern: /><|>[_.]</u, word: "ow" },
  { pattern: /[♡♥❤]/u, word: "heart" },
  { pattern: /ツ/u, word: "shrug" },
  { pattern: /-_-|-\.-|=_=|・_・/u, word: "disgust" },
  { pattern: /[＾^▽‿ᴗ◕●•ω≧≦￣´｀°˘‾-]/u, word: "smile" },
];

const KAOMOJI_FACE_CHARS =
  /[＾▽‿ᴗω◕●•｀´≧≦￣ДツТ°｡♡♥❤╥＃#╬><;~＿=]|^[（(][TtoOxXuUnNmMwWvV_.;'"~^=-]+[)）]$/u;

function kaomojiMood(face) {
  if (!KAOMOJI_FACE_CHARS.test(face)) return null;
  for (const mood of KAOMOJI_MOODS) {
    if (mood.pattern.test(face)) return mood.word;
  }
  return null;
}

function detectTextMood(text) {
  const value = String(text || "");

  const kaomojiMatches = value.match(KAOMOJI_PATTERN) || [];
  for (const match of kaomojiMatches) {
    const mood = kaomojiMood(match);
    if (mood) return mood;
  }

  for (const [pattern, mood] of EMOJI_MOODS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) return mood;
  }

  return null;
}

const EXCITED_WORDS =
  /!{2,}|\b(yay|yes|nice|great|awesome|amazing|let'?s go|finally|hehe|haha)\b/;
const ANGRY_WORDS =
  /\b(angry|mad|annoyed|ugh|hmph|stupid|idiot|seriously|how dare|stop that)\b/;
const DISGUST_WORDS =
  /\b(disgusting|disgusted|gross|grossed out|yuck+y?|ew+|nasty|revolting|repulsive|eww+)\b/;

const MOOD_VALENCE = {
  smile: 1,
  haha: 1,
  wink: 1,
  sparkle: 1,
  yay: 1,
  "thumbs up": 1,
  wave: 1,
  heart: 1,
  gasp: 0,
  sniff: -1,
  ow: -1,
  grr: -1,
  hmph: -1,
  disgust: -1,
  hmm: 0,
  yawn: 0,
  shrug: 0,
  phew: 0,
};

// -1 (negative), 0 (neutral/no signal), or 1 (positive) -- the coarse
// signal userAffectState actually needs, built on the same mood detection
// reply-emotion.js already does for the avatar's expression.
function detectTextValence(text) {
  const mood = detectTextMood(text);
  if (mood && mood in MOOD_VALENCE) return MOOD_VALENCE[mood];

  const lower = String(text || "").toLowerCase();
  if (DISGUST_WORDS.test(lower) || ANGRY_WORDS.test(lower)) return -1;
  if (EXCITED_WORDS.test(lower)) return 1;
  return 0;
}

module.exports = { detectTextMood, detectTextValence };
