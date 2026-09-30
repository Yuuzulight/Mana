// #923/#925/#926: my saved speech settings, one small JSON file I can also
// edit by hand (data/speech.json):
//   words        extra whisper prompt terms, right after WHISPER_VOCABULARY
//   corrections  { "GG Moon": "Gigi Murin" }: what whisper keeps writing ->
//                what I said, fixed in every transcript (correctTranscript)
//   language     "en" (default) or "auto"; WHISPER_LANGUAGE wins
// Only I add to it, from Settings > Voice or by asking Mana (speech__*
// tools); nothing is learned into it automatically. Entries go through the
// prompt's cleanTerm, so the file can't smuggle free text into the prompt.
// A hand edit is read at the next backend start.
const fs = require("node:fs");
const path = require("node:path");
const { cleanTerm, isJargon } = require("./whisper-prompt");

const LANGUAGES = ["en", "auto"];

// "GG Moon" -> a whole-phrase pattern: any whitespace between the words,
// no letter or digit right before or after.
function phraseSource(phrase) {
  return phrase
    .split(" ")
    .map((word) => word.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"))
    .join("\\s+");
}

function phraseRegex(alternatives, flags) {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}])`, flags);
}

// True if phrase is in text as whole words, any case.
function saysPhrase(text, phrase) {
  return Boolean(phrase) && phraseRegex([phraseSource(phrase)], "iu").test(String(text || "").normalize("NFKC"));
}

// One pass, longest first, so "GG Moon" beats a shorter "GG" and a fix is
// never corrected again by another entry.
function correctTranscript(text, corrections = {}) {
  const byHeard = new Map(Object.entries(corrections).map(([heard, term]) => [heard.toLowerCase(), term]));
  if (!text || !byHeard.size) return text;
  const alternatives = [...byHeard.keys()].sort((a, b) => b.length - a.length).map(phraseSource);
  return String(text).replace(phraseRegex(alternatives, "giu"), (m) => byHeard.get(m.toLowerCase().replace(/\s+/g, " ")) ?? m);
}

// #925: fixing a single ordinary word ("immortal") would rewrite it every
// time I really say it. There's no dictionary here, so one word with no
// capital or digit inside counts as possibly ordinary and needs confirm
// ("Onesan" too); a phrase ("GG Moon") or a jargon-shaped word
// ("GGMorin", "CloudRain") doesn't.
// ponytail: shape rule, not a dictionary -- add a word list if the false
// positives get annoying.
function mayBeOrdinaryWord(heard) {
  return !heard.includes(" ") && !isJargon(heard);
}

function clean(raw, what) {
  const term = cleanTerm(raw);
  if (!term) throw new Error(`${what} must be a word or name of up to 32 letters, digits, ' . or -`);
  return term;
}

function createSpeechVocabulary({ filePath }) {
  let loadError = null;
  const data = { words: [], corrections: {}, language: "en" };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    data.words = (Array.isArray(raw.words) ? raw.words : []).filter((w) => typeof w === "string").map(cleanTerm).filter(Boolean);
    for (const [heard, term] of Object.entries(raw.corrections || {})) {
      if (cleanTerm(heard) && cleanTerm(term)) data.corrections[cleanTerm(heard)] = cleanTerm(term);
    }
    data.language = LANGUAGES.includes(raw.language) ? raw.language : "en";
  } catch (e) {
    // A broken hand edit mustn't be overwritten by the next save.
    if (e.code !== "ENOENT") {
      loadError = e;
      console.warn(`Couldn't read ${filePath}, speech words are off until it's fixed:`, e.message);
    }
  }

  // Changes a copy and swaps it in only once it's on disk, so a failed
  // write (or a broken hand edit, which mustn't be overwritten) changes
  // nothing.
  function update(change) {
    if (loadError) throw new Error(`${path.basename(filePath)} couldn't be read (${loadError.message}); fix or delete it first`);
    const next = structuredClone(data);
    const result = change(next);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(`${filePath}.tmp`, `${JSON.stringify(next, null, 2)}
`, "utf8");
    fs.renameSync(`${filePath}.tmp`, filePath);
    Object.assign(data, next);
    return result;
  }

  const same = (a) => (b) => a.toLowerCase() === b.toLowerCase();

  return {
    words: () => [...data.words],
    language: () => data.language,
    state: () => structuredClone(data),
    correct: (text) => correctTranscript(text, data.corrections),

    addWord(raw) {
      const word = clean(raw, "word");
      return update((d) => {
        if (!d.words.some(same(word))) d.words.push(word);
        return word;
      });
    },

    // Drops the word, and any correction from or to it. True if anything
    // went.
    removeWord(raw) {
      const is = same(cleanTerm(raw));
      if (!data.words.some(is) && !Object.entries(data.corrections).some((pair) => pair.some(is))) return false;
      return update((d) => {
        d.words = d.words.filter((w) => !is(w));
        for (const pair of Object.entries(d.corrections)) {
          if (pair.some(is)) delete d.corrections[pair[0]];
        }
        return true;
      });
    },

    // Throws with needsConfirm set when heard may be an ordinary word.
    addCorrection(heardRaw, termRaw, { confirm = false } = {}) {
      const heard = clean(heardRaw, "heard");
      const term = clean(termRaw, "term");
      if (same(heard)(term)) throw new Error("heard and term are the same");
      if (mayBeOrdinaryWord(heard) && !confirm) {
        throw Object.assign(
          new Error(`"${heard}" may be an ordinary word: fixing it would change it every time it's really said`),
          { needsConfirm: true },
        );
      }
      return update((d) => {
        for (const key of Object.keys(d.corrections)) {
          if (same(key)(heard)) delete d.corrections[key];
        }
        d.corrections[heard] = term;
        return { heard, term };
      });
    },

    removeCorrection(heardRaw) {
      const key = Object.keys(data.corrections).find(same(cleanTerm(heardRaw)));
      if (key === undefined) return false;
      return update((d) => delete d.corrections[key]);
    },

    setLanguage(language) {
      if (!LANGUAGES.includes(language)) throw new Error(`language must be one of ${LANGUAGES.join(", ")}`);
      update((d) => {
        d.language = language;
      });
    },
  };
}

// #926: WHISPER_LANGUAGE wins; otherwise the Settings choice, English by
// default.
function resolveWhisperLanguage(envLanguage, saved) {
  return envLanguage || (saved === "auto" ? "auto" : "en");
}

module.exports = {
  correctTranscript,
  createSpeechVocabulary,
  mayBeOrdinaryWord,
  resolveWhisperLanguage,
  saysPhrase,
};
