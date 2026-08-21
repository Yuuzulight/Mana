// Issue #421: per-session remote-AI token usage, so a user can see what a
// chat session is actually costing once MANA_ALLOW_REMOTE_AI is on. Kept
// separate from utils/talk_budget.js -- that module paces Mana's own reply
// length (an estimate, applied to every session regardless of remote AI),
// a different concern from "what did the provider actually charge for."
//
// In-memory only, mirrors acp-autonomous-loop.js's sessionToolCounts Map
// shape -- resets on process restart. That's an accepted limitation for a
// live cost-visibility meter (same one the tool-call cap already has), not
// a persisted ledger.
const usageBySession = new Map();

function recordUsage(sessionId, usage) {
  const key = String(sessionId || "default");
  const promptTokens = Number(usage && usage.prompt_tokens) || 0;
  const completionTokens = Number(usage && usage.completion_tokens) || 0;
  const existing = usageBySession.get(key) || {
    promptTokens: 0,
    completionTokens: 0,
    calls: 0,
  };
  existing.promptTokens += promptTokens;
  existing.completionTokens += completionTokens;
  existing.calls += 1;
  usageBySession.set(key, existing);
  return getUsage(key);
}

function getUsage(sessionId) {
  const key = String(sessionId || "default");
  const entry = usageBySession.get(key) || {
    promptTokens: 0,
    completionTokens: 0,
    calls: 0,
  };
  return {
    promptTokens: entry.promptTokens,
    completionTokens: entry.completionTokens,
    totalTokens: entry.promptTokens + entry.completionTokens,
    calls: entry.calls,
  };
}

// Test-only escape hatch, same shape as acp-autonomous-loop.js's
// resetSessionToolCounts -- production code never calls this.
function resetSessionTokenUsage(sessionId) {
  if (sessionId === undefined) {
    usageBySession.clear();
    return;
  }
  usageBySession.delete(String(sessionId));
}

module.exports = { recordUsage, getUsage, resetSessionTokenUsage };
