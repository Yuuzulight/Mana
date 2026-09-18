// Item 2 of the LimitCantCode-derived gap list: a user-editable list of
// word-level pronunciation overrides for TTS (e.g. "Qwen" -> "kwen"),
// additive to utils/speech-text.js's small, developer-curated
// PRONUNCIATION_FIXES array -- that list covers vowel-less interjections;
// this store covers proper nouns/model names Mana's TTS mispronounces.
// Same shape as hooks-store.js: one JSON file, atomic tmp+rename write,
// dataDir injectable for tests, crypto-random hex ids.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_DATA_DIR = path.join(__dirname, "data", "pronunciation-lexicon");

function readEntries(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    // Malformed/hand-edited file -- fall back to "no overrides" rather than
    // breaking every reply's TTS pass.
    return [];
  }
}

function writeEntries(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

// Single words only -- see utils/speech-text.js's applyPronunciationLexicon,
// which matches these as \b-bounded alternatives, not phrases.
function cleanWord(value, label) {
  const trimmed = String(value == null ? "" : value).trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  if (/\s/.test(trimmed)) {
    throw new Error(`${label} must be a single word, not a phrase`);
  }
  return trimmed;
}

function cleanReplacement(value, label) {
  const trimmed = String(value == null ? "" : value).trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

// Case-insensitive on purpose: speech-time matching is also case-insensitive
// (see speech-text.js), so an entry for "Qwen" and one for "qwen" would
// otherwise race depending on lexicon order -- reject the second add instead.
function findByWord(entries, word, excludeId) {
  const lower = word.toLowerCase();
  return entries.find((e) => e.id !== excludeId && String(e.word).toLowerCase() === lower);
}

// options.dataDir: injectable so tests never write into node-bot's real
// data directory (same pattern as hooks-store.js/presets-store.js).
function createPronunciationLexiconStore(options = {}) {
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const filePath = path.join(dataDir, "pronunciation-lexicon.json");
  const makeId = options.makeId || (() => crypto.randomBytes(4).toString("hex"));
  const now = options.now || (() => new Date().toISOString());

  function listWords() {
    return readEntries(filePath);
  }

  function addWord({ word, replacement } = {}) {
    const cleanedWord = cleanWord(word, "word");
    const cleanedReplacement = cleanReplacement(replacement, "replacement");

    const entries = listWords();
    if (findByWord(entries, cleanedWord)) {
      throw new Error(`a pronunciation entry for "${cleanedWord}" already exists`);
    }

    const entry = {
      id: makeId(),
      word: cleanedWord,
      replacement: cleanedReplacement,
      createdAt: now(),
    };
    entries.push(entry);
    writeEntries(filePath, entries);
    return entry;
  }

  function updateWord(id, updates = {}) {
    const entries = listWords();
    const index = entries.findIndex((e) => e.id === id);
    if (index === -1) return null;

    const updated = { ...entries[index] };
    if (updates.word !== undefined) {
      const cleanedWord = cleanWord(updates.word, "word");
      if (findByWord(entries, cleanedWord, id)) {
        throw new Error(`a pronunciation entry for "${cleanedWord}" already exists`);
      }
      updated.word = cleanedWord;
    }
    if (updates.replacement !== undefined) {
      updated.replacement = cleanReplacement(updates.replacement, "replacement");
    }

    entries[index] = updated;
    writeEntries(filePath, entries);
    return updated;
  }

  function removeWord(id) {
    const entries = listWords();
    const next = entries.filter((e) => e.id !== id);
    if (next.length === entries.length) return false;
    writeEntries(filePath, next);
    return true;
  }

  return { dataDir, listWords, addWord, updateWord, removeWord };
}

module.exports = { createPronunciationLexiconStore };
