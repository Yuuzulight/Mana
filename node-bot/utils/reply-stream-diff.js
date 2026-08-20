// Issue #331: buildAssistantReply's post-processing (rut-detection regen,
// verify/retry, phrasing-variation rewrite) can replace the reply text
// wholesale after streaming has already started speaking sentences from
// the first draft. This is the single source of truth for "does what was
// already streamed and spoken still match the true final reply" -- kept as
// a pure function so the cancel-and-restart decision is testable without a
// live model or TTS service.
function streamedMatchesFinal(streamedSentences, finalReply) {
  if (!Array.isArray(streamedSentences) || streamedSentences.length === 0) {
    return false;
  }
  const streamedJoined = streamedSentences.join(" ").trim();
  const final = String(finalReply ?? "").trim();
  return streamedJoined === final;
}

module.exports = { streamedMatchesFinal };
