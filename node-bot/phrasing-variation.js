// Issue #160: catches Mana's own well-worn catchphrases/openers/kaomoji
// before a reply goes to TTS, and asks the model for one alternate
// phrasing of just that part -- not a full regeneration, and never a
// content change. Pairs with windows-launcher's reply-emotion.js (which
// reads whatever kaomoji/emoji actually end up in the final text to pick
// an avatar mood) rather than replacing it.
//
// Hand-curated, not learned -- matches this codebase's existing bias
// toward deterministic checks before reaching for anything ML-driven
// (skills pruning, issue #140). Edit this list directly to tune Mana's
// verbal tics over time; there's no admin UI for it, per the issue's own
// scope.
const DEFAULT_LEXICON = [
  { id: "mou-opener", pattern: /\bmou[,~.]?\s+/i },
  { id: "hmph-opener", pattern: /\bhmph[,!.]?\s+/i },
  { id: "geez-opener", pattern: /\bgeez[,!.]?\s+/i },
  { id: "well-well-opener", pattern: /\bwell,?\s+well,?\s+/i },
  { id: "fufu-opener", pattern: /\bfufu[,~.]?\s+/i },
  { id: "not-that-i-care", pattern: /not that i care(?: or anything)?/i },
  { id: "dont-get-the-wrong-idea", pattern: /don'?t get the wrong idea/i },
  { id: "i-guess-i-could-help", pattern: /i guess i (?:could|can) help/i },
  { id: "if-you-insist", pattern: /if you insist/i },
  { id: "kaomoji-happy", pattern: /[（(]\s*[＾^][\s_-]*[▽∀△][\s_-]*[＾^]\s*[)）]/u }, // (＾▽＾)
  { id: "kaomoji-sniff", pattern: /[（(]\s*T[\s_-]*T\s*[)）]/iu }, // (T_T)
  { id: "kaomoji-smug", pattern: /[（(]\s*｀[^´)）]*´\s*[)）]/u }, // (｀・ω・´)
];

function findLexiconMatch(text, lexicon = DEFAULT_LEXICON) {
  const value = String(text || "");
  for (const entry of lexicon) {
    const match = entry.pattern.exec(value);
    if (match && match[0].trim()) {
      return { id: entry.id, matchedText: match[0].trim() };
    }
  }
  return null;
}

// options.lookback: how many of a session's recent replies to remember
// which catchphrase/opener (by lexicon id) each one used.
function createPhrasingVariator(options = {}) {
  const lookback = options.lookback ?? 3;
  const lexicon = options.lexicon ?? DEFAULT_LEXICON;
  const history = new Map();

  function recentlyUsed(sessionId, id) {
    return (history.get(sessionId) || []).includes(id);
  }

  // Records what the *final* reply (after any rewrite) actually used --
  // call once per reply, after any rewrite has already happened, so
  // history reflects what Mana actually said rather than what she almost
  // said.
  function recordUsage(sessionId, id) {
    if (!id) return;
    const list = history.get(sessionId) || [];
    list.push(id);
    history.set(sessionId, list.slice(-lookback));
  }

  // Read-only: does replyText contain a lexicon match that was already
  // used in one of this session's last `lookback` recorded replies?
  function checkReply(sessionId, replyText) {
    const match = findLexiconMatch(replyText, lexicon);
    if (!match) return { isPredictable: false, match: null };
    return { isPredictable: recentlyUsed(sessionId, match.id), match };
  }

  return {
    checkReply,
    recordUsage,
    findLexiconMatch: (text) => findLexiconMatch(text, lexicon),
  };
}

// A small, targeted completion -- rewrites only the matched fragment, not
// the whole reply. `synthesize` is an injected (prompt) => text function
// (e.g. a low-token-budget local model call), so this module has no
// direct knowledge of which model/runtime is in use.
async function rewritePhrase(matchedText, options = {}) {
  const synthesize = options.synthesize;
  if (typeof synthesize !== "function") {
    throw new Error("synthesize is required");
  }
  const prompt =
    "Give one short alternate way to phrase this expression, keeping the same meaning and tone but different wording. " +
    "Reply with only the alternate phrase, nothing else, no quotation marks.\n\n" +
    `Original: ${matchedText}\nAlternate:`;
  const result = await synthesize(prompt);
  return String(result || "")
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, "");
}

module.exports = {
  DEFAULT_LEXICON,
  findLexiconMatch,
  createPhrasingVariator,
  rewritePhrase,
};
