// Prepares reply text for TTS: emojis and Japanese kaomojis become short
// spoken words ("smile", "sniff") instead of long Unicode names or garbage,
// and anything unmapped is dropped rather than read aloud.

// Emoji → short spoken word, grouped by what Mana would actually say.
const EMOJI_SPOKEN_WORDS = [
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
  [/[\u{1F62E}\u{1F632}\u{1F633}]/gu, "gasp"],
  [/\u{1F914}/gu, "hmm"],
  [/[\u{1F634}\u{1F4A4}]/gu, "yawn"],
  [/[\u{2728}\u{1F31F}\u{2B50}]/gu, "sparkle"],
  [/[\u{1F389}\u{1F38A}\u{1F973}]/gu, "yay"],
  [/\u{1F44D}/gu, "thumbs up"],
  [/\u{1F44B}/gu, "wave"],
];

// Kaomoji face candidates: a short parenthesized cluster, optionally with
// "arm" characters outside, e.g. (＾▽＾), (T_T), ヽ(´▽`)ノ, ¯\_(ツ)_/¯.
const KAOMOJI_PATTERN =
  /(?:[¯ヽ٩ᕕoO\\/]\s?[\\_]{0,2})?[（(][^（）()\s]{1,18}[)）](?:[_]{0,2}[\\/]?[¯ノ۶ᕗoO]?)?/gu;

// Character classes that identify what a kaomoji face expresses.
const KAOMOJI_MOODS = [
  { pattern: /[TТ╥;уД]_|_[TТ╥;]|;;|℃゜|(?:゜|｡)(?:\.|,)/u, word: "sniff" },
  { pattern: /[＃#╬凸]/u, word: "grr" },
  { pattern: /｀[^´]*´/u, word: "hmph" },
  { pattern: /><|>[_.]</u, word: "ow" },
  { pattern: /[♡♥❤]/u, word: "heart" },
  { pattern: /ツ/u, word: "shrug" },
  { pattern: /[＾^▽‿ᴗ◕●•ω≧≦￣´｀°˘‾-]/u, word: "smile" },
];

// A parenthesized span only counts as a kaomoji when it contains face-like
// symbols; "(really)" and "(see docs)" must never match.
const KAOMOJI_FACE_CHARS =
  /[＾▽‿ᴗω◕●•｀´≧≦￣ДツТ°｡♡♥❤╥＃#╬><;~＿]|^[（(][TtoOxXuUnNmMwWvV_.;'"~^-]+[)）]$/u;

function kaomojiToWord(face) {
  if (!KAOMOJI_FACE_CHARS.test(face)) {
    return null;
  }
  for (const mood of KAOMOJI_MOODS) {
    if (mood.pattern.test(face)) {
      return mood.word;
    }
  }
  return "";
}

// Vowel-less interjections make grapheme-to-phoneme fall back to spelling
// letters out loud ("h m p h"). Swap them for pronounceable spellings at
// speech time — chat text keeps the original wording.
const PRONUNCIATION_FIXES = [
  // Requires the "p" so a plain thinking "hmm" stays untouched.
  [/\bhm+p[fh]?\b/gi, "humph"],
  [/\bgrr+\b/gi, "argh"],
  [/\btsk+(?:\s+tsk+)*\b/gi, "tut tut"],
  [/\bsh+h\b/gi, "shush"],
  [/\bzz+z\b/gi, "snooze"],
  [/\bpff+t?\b/gi, "humph"],
  [/\bnn+\b/gi, "mm-hmm"],
];

function applyPronunciationFixes(text) {
  let result = String(text || "");
  for (const [pattern, replacement] of PRONUNCIATION_FIXES) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// "so~" is anime-speak for dragging the word out — stretch the last vowel
// ("sooooo") instead of letting TTS narrate the tilde. More tildes stretch
// further; a trailing consonant is kept ("think~" -> "thiiiiink").
function stretchWordForTilde(word, tildeCount) {
  const extra = Math.min(8, 3 + tildeCount);
  const match = word.match(/([aeiouy]+)([^aeiouy]*)$/i);
  if (match && match[1]) {
    const runEnd = word.length - match[2].length;
    const ch = word[runEnd - 1];
    return word.slice(0, runEnd) + ch.repeat(extra) + word.slice(runEnd);
  }
  const last = word[word.length - 1];
  return /[a-z]/i.test(last || "") ? word + last.repeat(3) : word;
}

function applyTildeStretch(text) {
  return String(text || "")
    // word (+ optional punctuation) followed by tildes: stretch the word,
    // keep the punctuation, drop the tildes.
    .replace(/([A-Za-z]+)([,.!?;:]*)~+/g, (full, word, punct) => {
      const tildes = (full.match(/~/g) || []).length;
      return stretchWordForTilde(word, tildes) + punct;
    })
    // any tildes not attached to a word just disappear from speech
    .replace(/~+/g, " ");
}

function normalizeSpeechText(text) {
  let result = String(text || "");

  // Kaomojis first (they may contain characters the emoji pass would touch).
  result = result.replace(KAOMOJI_PATTERN, (match) => {
    const word = kaomojiToWord(match);
    if (word === null) {
      return match; // an ordinary parenthetical, leave it alone
    }
    return word ? ` ${word} ` : " ";
  });

  // Known emoji become short words.
  for (const [pattern, word] of EMOJI_SPOKEN_WORDS) {
    result = result.replace(pattern, ` ${word} `);
  }

  // Everything else pictographic is dropped instead of being read out as
  // "smiling face with smiling eyes".
  result = result
    .replace(/[\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu, "")
    .replace(/\p{Extended_Pictographic}/gu, " ");

  // Stretch trailing tildes into elongated vowels before pronunciation
  // fixes so stretched interjections still resolve.
  result = applyTildeStretch(result);

  // Make interjections pronounceable (covers both the mood words inserted
  // above and ones Mana writes herself, like "Hmph!").
  result = applyPronunciationFixes(result);

  // Tidy up the leftovers.
  return result
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

module.exports = {
  applyPronunciationFixes,
  applyTildeStretch,
  normalizeSpeechText,
};
