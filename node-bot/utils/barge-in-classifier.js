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
  const matchedCorrection = correctionKeywords.find((keyword) => textLower.includes(keyword));
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
  const matchedBackchannel = backchannelKeywords.find((keyword) => textLower.includes(keyword));
  if (matchedBackchannel) {
    return { category: "backchannel", reason: `matched_backchannel_keyword (${matchedBackchannel})` };
  }

  // 4. Default.
  return { category: "unclassified", reason: "default_fallback" };
}

module.exports = { classifyBargeIn };
