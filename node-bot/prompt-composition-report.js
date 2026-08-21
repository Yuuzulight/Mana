// Issue #400: records the composition of the last assembled prompt per
// session -- per-block size and what each block dropped -- so silent
// truncation (the #364 kind: real data loss with nothing to show for it)
// becomes observable instead of only discoverable by reading the code.
//
// In-memory only, same shape as session-token-usage.js (issue #421):
// resets on process restart, which is fine for a live diagnostic snapshot
// rather than a persisted ledger. Stores the LATEST composition per
// session (a replace, not an accumulate) -- this reports what the last
// assembled prompt actually contained, not a running history.
const compositionBySession = new Map();

// Matches the char/4 heuristic acp-memory-store.js's selectPartsWithinTokenBudget
// actually truncates against (its real HTTP tokenizer result is discarded --
// see that file's own comment), so the estimate here matches the truncation
// decisions being reported, not a different, unused estimator.
function estimateTokens(chars) {
  return Math.max(0, Math.ceil(Number(chars || 0) / 4));
}

function recordPromptComposition(sessionId, blocks) {
  const key = String(sessionId || "default");
  const normalizedBlocks = (blocks || []).map((block) => ({
    name: block.name,
    chars: Number(block.chars || 0),
    estTokens: estimateTokens(block.chars),
    dropped: block.dropped || null,
  }));
  const record = {
    at: new Date().toISOString(),
    blocks: normalizedBlocks,
    totalChars: normalizedBlocks.reduce((sum, b) => sum + b.chars, 0),
    totalEstTokens: normalizedBlocks.reduce((sum, b) => sum + b.estTokens, 0),
  };
  compositionBySession.set(key, record);
  return record;
}

function getPromptComposition(sessionId) {
  const key = String(sessionId || "default");
  return compositionBySession.get(key) || null;
}

// For Doctor (issue #400): Doctor has no specific session in mind, so it
// reports on whichever reply was assembled most recently, across every
// session -- the freshest signal of "did the last reply we actually built
// drop anything," rather than the arbitrary "default" key that most real
// sessions (which always pass a real sessionId) would never populate.
function getMostRecentComposition() {
  let latest = null;
  for (const record of compositionBySession.values()) {
    if (!latest || record.at > latest.at) latest = record;
  }
  return latest;
}

// Test-only escape hatch, same shape as session-token-usage.js's
// resetSessionTokenUsage -- production code never calls this.
function resetPromptCompositionReport(sessionId) {
  if (sessionId === undefined) {
    compositionBySession.clear();
    return;
  }
  compositionBySession.delete(String(sessionId));
}

module.exports = {
  recordPromptComposition,
  getPromptComposition,
  getMostRecentComposition,
  resetPromptCompositionReport,
};
