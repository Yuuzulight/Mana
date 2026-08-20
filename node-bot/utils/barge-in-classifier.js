/**
 * Classifies a transcribed barge-in interruption so the caller can decide
 * whether to resume the reply that was cut off, discard it, or answer the
 * interruption and then resume. Matches intent-classifier.js's style:
 * ordered keyword lists, .includes() checks, explicit fallback.
 *
 * @param {string} text
 * @returns {{ category: 'backchannel'|'correction'|'new_question'|'unclassified', reason: string }}
 */
function classifyBargeIn(text) {
  if (!text || typeof text !== "string") {
    return { category: "unclassified", reason: "empty_or_invalid_input" };
  }
  const textLower = text.toLowerCase().trim();

  // Short/bare-word keywords ("no", "ok") collide with substrings of
  // unrelated words ("now", "know", "joke") under .includes(), so match
  // those on word boundaries; multi-word phrases ("hold on", "never mind")
  // aren't single dictionary words that collide, so substring is fine.
  const words = textLower.split(/[^a-z']+/).filter(Boolean);
  const matchesKeyword = (keyword) =>
    keyword.includes(" ") ? textLower.includes(keyword) : words.includes(keyword);

  // 1. Correction/stop keywords -- checked first (fast-path) so a sentence
  // that also happens to contain a question word ("wait, is that right")
  // still stops the reply instead of being treated as a new question.
  const correctionKeywords = [
    "wait",
    "stop",
    "hold on",
    "no",
    "nevermind",
    "never mind",
    "actually",
  ];
  const matchedCorrection = correctionKeywords.find(matchesKeyword);
  if (matchedCorrection) {
    return { category: "correction", reason: `matched_correction_keyword (${matchedCorrection})` };
  }

  // 2. New-question heuristic: starts with a question word, or ends in "?".
  const questionWords = [
    "what",
    "why",
    "how",
    "when",
    "where",
    "who",
    "can",
    "could",
    "do",
    "does",
    "is",
    "are",
  ];
  const firstWord = textLower.split(/\s+/)[0];
  if (questionWords.includes(firstWord) || textLower.endsWith("?")) {
    return { category: "new_question", reason: "question_shape" };
  }

  // 3. Backchannel keywords.
  const backchannelKeywords = [
    "mhm",
    "yeah",
    "okay",
    "ok",
    "right",
    "uh huh",
    "got it",
    "sure",
    "cool",
  ];
  const matchedBackchannel = backchannelKeywords.find(matchesKeyword);
  if (matchedBackchannel) {
    return { category: "backchannel", reason: `matched_backchannel_keyword (${matchedBackchannel})` };
  }

  // 4. Default: short utterances (<=3 words) are treated the same as a
  // backchannel (resume-worthy, matches "mhm"/"right"/"sure" that slipped
  // past the keyword list) -- longer text that matched nothing is very
  // likely a real request ("set a timer", "play some music"), and treating
  // it as unclassified-means-resume would silently drop it. Route longer
  // unmatched text the same as new_question instead.
  if (words.length <= 3) {
    return { category: "unclassified", reason: "default_fallback_short" };
  }
  return { category: "new_question", reason: "default_fallback_long" };
}

module.exports = { classifyBargeIn };
