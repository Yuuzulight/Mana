// Issue #667: whisper.cpp's initial prompt biases the decoder toward words
// it has already "seen", so seeding it with the user's name and the proper
// nouns / project terms they actually use helps those come through right
// with an accent. Vocabulary only (names and terms): no slang lists, since
// the user speaks accented English, not Singlish; and no free text from
// memory, since facts can carry prompt-injected content. Every term is
// reduced to letters, digits and ' . - before it gets in.

// Keeps the "Singapore English" framing (helps the decoder's accent
// expectations), per docs/speech_recognition_improvement_plan.md. Only
// "Mana" is named: listing misspellings (Manah, Manna...) here made
// whisper write them. WakeWordMatcher still accepts those on its own.
const BASE_WHISPER_PROMPT =
  "Singapore English conversation with an AI assistant named Mana. Wake words include Mana and wake up.";

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
// Capitalized mid-sentence, but not a name. #667: also exclamations ("oh my
// God"; "Jesus Christ" put "Christ" in a real prompt) and days/months --
// capitalized, but whisper already knows them, so they'd only spend the
// term budget.
const NOT_TERMS = new Set([
  ..."i'm i'll i've i'd ok god gosh jesus christ lord omg".split(" "),
  ..."monday tuesday wednesday thursday friday saturday sunday".split(" "),
  ..."january february march april may june july august september october november december".split(" "),
]);

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

// Jargon-shaped: a capital or digit inside ("FFXIV", "PyTorch", "S1"), or a
// capitalized word with a dot inside ("Node.js", #667).
function isJargon(term) {
  return (
    /\p{Lu}/u.test(term.slice(1)) ||
    (/\p{N}/u.test(term) && /\p{L}/u.test(term)) ||
    /^\p{Lu}.*\.\p{L}/u.test(term)
  );
}

// Words that look like names or jargon: capitalized mid-sentence ("I
// switched to Kokoro"), or jargon-shaped anywhere. A capitalized
// sentence-initial word ("Want", "Hey") says nothing, which is why the
// entity index isn't used here. #924: a run of 2-3 capitalized words
// ("Gigi Murin", "Hololive VTuber") is one term instead of its words; a
// comma or possessive ends a run, and a longer run (a title, shouting)
// stays single words. skip: words already in the prompt, which also end a
// run ("hey Mana Gigi Murin" -> "Gigi Murin").
// ponytail: capitalization heuristic, not NER.
function extractTerms(text, skip = new Set()) {
  const terms = [];
  // A sentence end needs whitespace (or the end) after it, so "Node.js"
  // stays one word.
  for (const sentence of String(text || "").split(/[.!?]+(?:\s+|$)|\n+/)) {
    const words = sentence.split(/\s+/).filter(Boolean);
    let run = [];
    const flush = () => {
      const phrase = run.length >= 2 && run.length <= 3 ? cleanTerm(run.join(" ")) : "";
      terms.push(...(phrase ? [phrase] : run));
      run = [];
    };
    words.forEach((word, i) => {
      const term = cleanTerm(word.replace(/['’]s$/i, ""));
      const key = term.toLowerCase();
      if (term.length < 2 || term.includes(" ") || NOT_TERMS.has(key) || skip.has(key)) return flush();
      if (i > 0 && /^\p{Lu}/u.test(term)) {
        run.push(term);
        if (/(?:['’]s|[,;:)])$/i.test(word)) flush();
      } else {
        flush();
        if (isJargon(term)) terms.push(term);
      }
    });
    flush();
  }
  return terms;
}

// Pure builder: same inputs, same prompt. Terms are deduped
// case-insensitively (first spelling seen wins), ordered by how many sources
// (facts/turns) they occur in and then alphabetically, and cut to fit
// MAX_TERMS / MAX_PROMPT_CHARS. #667: a plain capitalized word needs a
// verified memory fact or at least 2 chat turns -- on real data every one-off
// capital ("Ali", "Baba") came from a single garbled voice transcript, never
// from a fact -- while jargon-shaped terms need only one source.
// #901: vocabulary (WHISPER_VOCABULARY) is the user's own list, kept in their
// order right after the name, ahead of anything memory suggests. #923: the
// saved speech words (speech-vocabulary.js) follow it in the same list.
function buildWhisperPrompt({ facts = [], userTexts = [], vocabulary = [] } = {}) {
  const usableFacts = facts.filter(isUsableFact);
  const name = userNameFromFacts(usableFacts);
  // Words already in the prompt, split the same way extractTerms does.
  const words = (text) => text.split(/[.!?]+(?:\s+|$)|[\s,]+/).map((w) => cleanTerm(w).toLowerCase());
  const known = new Set(words(`${BASE_WHISPER_PROMPT} ${name}`));
  const vocab = [];
  for (const term of vocabulary.map(cleanTerm)) {
    if (!term || known.has(term.toLowerCase())) continue;
    vocab.push(term);
    for (const w of [term, ...words(term)]) known.add(w.toLowerCase());
  }

  const counts = new Map();
  const termFacts = usableFacts.filter((f) => !NAME_KEY.test(String(f.key || "").trim()));
  const sources = [
    ...termFacts.map((f) => ({ text: `${f.key}. ${f.text}`, isFact: true })),
    ...userTexts.map((text) => ({ text, isFact: false })),
  ];
  for (const { text, isFact } of sources) {
    const seen = new Set();
    for (const term of extractTerms(text, known)) {
      const key = term.toLowerCase();
      if (known.has(key) || seen.has(key)) continue;
      seen.add(key);
      const entry = counts.get(key) || { term, count: 0, inFact: false };
      entry.count += 1;
      entry.inFact = entry.inFact || isFact;
      counts.set(key, entry);
    }
  }
  const ranked = [...counts.values()]
    // A name run ("Gigi Murin") always needs the 2 turns or a fact, even
    // with a capital inside.
    .filter((entry) => entry.inFact || entry.count >= 2 || (!entry.term.includes(" ") && isJargon(entry.term)))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, MAX_TERMS)
    .map((entry) => entry.term);

  const head = name ? `${BASE_WHISPER_PROMPT} The user's name is ${name}.` : BASE_WHISPER_PROMPT;
  const kept = [];
  for (const term of [...vocab, ...ranked].slice(0, MAX_TERMS)) {
    if (`${head} Names and terms: ${[...kept, term].join(", ")}.`.length > MAX_PROMPT_CHARS) break;
    kept.push(term);
  }
  return kept.length ? `${head} Names and terms: ${kept.join(", ")}.` : head;
}

// Returns getPrompt(): the WHISPER_PROMPT override when set, otherwise the
// built prompt, rebuilt at most every refreshMs (reading memory on every
// utterance would put file I/O on the STT hot path). Falls back to the
// base prompt (plus the vocabulary) if memory can't be read. vocabulary is
// WHISPER_VOCABULARY, comma-separated; savedWords() the saved speech words,
// which rebuild the prompt at once when they change (#923).
function createWhisperPromptProvider({
  memoryStore,
  override = "",
  vocabulary = "",
  savedWords = () => [],
  refreshMs = REFRESH_MS,
  now = Date.now,
} = {}) {
  let cached = null;
  let builtAt = 0;
  let builtWith = "";
  return function getPrompt() {
    if (override) return override;
    const saved = savedWords();
    const vocab = [...String(vocabulary).split(","), ...saved];
    if (cached && now() - builtAt < refreshMs && builtWith === saved.join("\n")) return cached;
    builtWith = saved.join("\n");
    try {
      const userTexts = memoryStore
        .listSessions()
        .slice(0, RECENT_SESSIONS)
        .flatMap((s) => (memoryStore.getSession(s.sessionId)?.turns || []).slice(-TURNS_PER_SESSION))
        .map((turn) => String(turn.user || "").slice(0, MAX_TURN_CHARS));
      cached = buildWhisperPrompt({ facts: memoryStore.listFacts(), userTexts, vocabulary: vocab });
    } catch (e) {
      console.warn("Failed to build whisper prompt from memory:", e.message);
      cached = buildWhisperPrompt({ vocabulary: vocab });
    }
    builtAt = now();
    return cached;
  };
}

module.exports = {
  BASE_WHISPER_PROMPT,
  MAX_PROMPT_CHARS,
  buildWhisperPrompt,
  cleanTerm,
  createWhisperPromptProvider,
  extractTerms,
  isJargon,
  isUsableFact,
  userNameFromFacts,
};
