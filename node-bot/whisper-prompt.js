// Issue #667: whisper.cpp's initial prompt biases the decoder toward words
// it has already "seen", so seeding it with the user's name and the proper
// nouns / project terms they actually use helps those come through right
// with an accent. Vocabulary only (names and terms): no slang lists, since
// the user speaks accented English, not Singlish; and no free text from
// memory, since facts can carry prompt-injected content. Every term is
// reduced to letters, digits and ' . - before it gets in.

// Keeps the "Singapore English" framing (helps the decoder's accent
// expectations) and Mana's wake words, per
// docs/speech_recognition_improvement_plan.md.
const BASE_WHISPER_PROMPT =
  "Singapore English conversation with an AI assistant named Mana. Wake words include Mana, Manah, Manna, Mannah, Myna, My Na, and wake up.";

// whisper's prompt budget is n_text_ctx/2 = 224 tokens, shared with the
// text carried over from the previous window. 450 chars stays under ~150
// tokens even at ~3 chars/token for unusual names.
const MAX_PROMPT_CHARS = 450;
const MAX_TERMS = 30;
const MAX_TERM_CHARS = 32;
const REFRESH_MS = 5 * 60 * 1000;
// Recent chat = the user's own last turns in the most recently updated
// sessions. Spoken turns are short; the per-turn cap keeps a long pasted
// block (code, a document) from flooding the term counts.
const RECENT_SESSIONS = 10;
const TURNS_PER_SESSION = 20;
const MAX_TURN_CHARS = 500;

// Fact keys the memory tool / Settings use for the user's name ("name" is
// the convention in test/memory-recall.test.js).
const NAME_KEY = /^(?:(?:the )?user(?:'?s)? |my |preferred )?name$/i;
// Capitalized mid-sentence, but not a name.
const NOT_TERMS = new Set(["i'm", "i'll", "i've", "i'd", "ok"]);

function cleanTerm(raw) {
  const term = String(raw || "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}'’.\- ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-'’.]+|[-'’.]+$/g, "");
  return term.length <= MAX_TERM_CHARS && /\p{L}/u.test(term) ? term : "";
}

function isUsableFact(fact) {
  return fact && fact.status === "active" && !fact.unverifiedSource && !fact.invalidatedAt;
}

// "Yuuzu", or "The user's name is Yuuzu" -> "Yuuzu". At most three words;
// anything longer isn't a name.
function userNameFromFacts(facts) {
  const fact = facts
    .filter((f) => NAME_KEY.test(String(f.key || "").trim()))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0];
  if (!fact) return "";
  const text = String(fact.text || "");
  const match = text.match(/\b(?:name is|called|goes by)\s+([^.,;!?\n]+)/i);
  const name = cleanTerm(match ? match[1] : text);
  return name && name.split(" ").length <= 3 ? name : "";
}

// Single words that look like names or jargon: capitalized mid-sentence
// ("I switched to Kokoro"), or with a capital/digit inside anywhere
// ("FFXIV", "PyTorch", "S1"). A capitalized sentence-initial word ("Want",
// "Hey") says nothing, which is why the entity index isn't used here.
// ponytail: capitalization heuristic, not NER.
function extractTerms(text) {
  const terms = [];
  for (const sentence of String(text || "").split(/[.!?\n]+/)) {
    const words = sentence.split(/\s+/).filter(Boolean);
    words.forEach((word, i) => {
      const term = cleanTerm(word.replace(/['’]s$/i, ""));
      if (term.length < 2 || term.includes(" ") || NOT_TERMS.has(term.toLowerCase())) return;
      const jargon = /\p{Lu}/u.test(term.slice(1)) || (/\p{N}/u.test(term) && /\p{L}/u.test(term));
      const properNoun = i > 0 && /^\p{Lu}/u.test(term);
      if (jargon || properNoun) terms.push(term);
    });
  }
  return terms;
}

// Pure builder: same inputs, same prompt. Terms are deduped
// case-insensitively (first spelling seen wins), ordered by how often they
// occur and then alphabetically, and cut to fit MAX_TERMS / MAX_PROMPT_CHARS.
function buildWhisperPrompt({ facts = [], userTexts = [] } = {}) {
  const usableFacts = facts.filter(isUsableFact);
  const name = userNameFromFacts(usableFacts);
  // Words already in the prompt; terms never contain "." (extractTerms
  // splits sentences on it), so neither do these.
  const known = new Set(`${BASE_WHISPER_PROMPT} ${name}`.toLowerCase().match(/[\p{L}\p{N}'’-]+/gu) || []);

  const counts = new Map();
  const termFacts = usableFacts.filter((f) => !NAME_KEY.test(String(f.key || "").trim()));
  const sources = [...termFacts.map((f) => `${f.key}. ${f.text}`), ...userTexts];
  for (const text of sources) {
    for (const term of extractTerms(text)) {
      const key = term.toLowerCase();
      if (known.has(key)) continue;
      const entry = counts.get(key) || { term, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
  }
  const ranked = [...counts.values()]
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, MAX_TERMS)
    .map((entry) => entry.term);

  const head = name ? `${BASE_WHISPER_PROMPT} The user's name is ${name}.` : BASE_WHISPER_PROMPT;
  const kept = [];
  for (const term of ranked) {
    if (`${head} Names and terms: ${[...kept, term].join(", ")}.`.length > MAX_PROMPT_CHARS) break;
    kept.push(term);
  }
  return kept.length ? `${head} Names and terms: ${kept.join(", ")}.` : head;
}

// Returns getPrompt(): the WHISPER_PROMPT override when set, otherwise the
// built prompt, rebuilt at most every refreshMs (reading memory on every
// utterance would put file I/O on the STT hot path). Falls back to the
// base prompt if memory can't be read.
function createWhisperPromptProvider({ memoryStore, override = "", refreshMs = REFRESH_MS, now = Date.now } = {}) {
  let cached = null;
  let builtAt = 0;
  return function getPrompt() {
    if (override) return override;
    if (cached && now() - builtAt < refreshMs) return cached;
    try {
      const userTexts = memoryStore
        .listSessions()
        .slice(0, RECENT_SESSIONS)
        .flatMap((s) => (memoryStore.getSession(s.sessionId)?.turns || []).slice(-TURNS_PER_SESSION))
        .map((turn) => String(turn.user || "").slice(0, MAX_TURN_CHARS));
      cached = buildWhisperPrompt({ facts: memoryStore.listFacts(), userTexts });
    } catch (e) {
      console.warn("Failed to build whisper prompt from memory:", e.message);
      cached = BASE_WHISPER_PROMPT;
    }
    builtAt = now();
    return cached;
  };
}

module.exports = {
  BASE_WHISPER_PROMPT,
  MAX_PROMPT_CHARS,
  buildWhisperPrompt,
  createWhisperPromptProvider,
  extractTerms,
};
