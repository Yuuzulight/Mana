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
// #642 (Q33c): sessions Mana has already told the chat is getting full.
const fullNoteSessions = new Set();

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

// Issue #642: turns a #400 record into a context-window meter -- how full
// the model's context was and what filled it.
//   texts:       block name -> the exact text that went into the prompt.
//                Blocks only known later in the turn (tool schemas, the
//                user turn) are added; every block gets `tokens`, a real
//                count from the loaded model's tokenizer (countTokens),
//                when it can answer. estTokens (char/4) stays alongside.
//   promptUsage: llama-server's own size of the prompt that produced the
//                reply ({promptTokens, promptN, cacheN}), when it ran.
//   contextSize: the context window that prompt had to fit in.
// unattributedTokens is what the blocks don't cover: chat-template markup
// and tool-call rounds' results. It can go negative when the template
// renders tool schemas more compactly than their raw JSON.
//
// Mutates and returns `record` -- the object recordPromptComposition
// returned -- rather than looking the session up again, so a slow finalize
// can never overwrite a newer turn's record.
async function finalizePromptComposition(
  record,
  { texts = {}, promptUsage = null, contextSize = null, countTokens = null } = {},
) {
  for (const [name, text] of Object.entries(texts)) {
    if (!record.blocks.some((b) => b.name === name)) {
      record.blocks.push({ name, chars: text.length, estTokens: estimateTokens(text.length), dropped: null });
    }
  }
  const counts = await Promise.all(
    record.blocks.map(async (block) => {
      const text = texts[block.name];
      if (text === undefined || typeof countTokens !== "function") return null;
      if (!text) return 0;
      try {
        return await countTokens(text);
      } catch (e) {
        return null;
      }
    }),
  );
  record.blocks.forEach((block, i) => {
    if (Number.isFinite(counts[i])) block.tokens = counts[i];
  });

  const counted = record.blocks.every((b) => Number.isFinite(b.tokens));
  record.totalChars = record.blocks.reduce((sum, b) => sum + b.chars, 0);
  record.totalEstTokens = record.blocks.reduce((sum, b) => sum + b.estTokens, 0);
  record.countedWith = counted ? "tokenizer" : "estimate";
  record.totalTokens = record.blocks.reduce((sum, b) => sum + (Number.isFinite(b.tokens) ? b.tokens : b.estTokens), 0);
  if (promptUsage) {
    record.promptTokens = promptUsage.promptTokens;
    record.promptN = promptUsage.promptN;
    record.cacheN = promptUsage.cacheN;
    if (counted) record.unattributedTokens = promptUsage.promptTokens - record.totalTokens;
  }
  record.contextSize = Number(contextSize) > 0 ? Number(contextSize) : null;
  const used = promptUsage ? promptUsage.promptTokens : record.totalTokens;
  record.percentUsed = record.contextSize ? Math.round((used / record.contextSize) * 1000) / 10 : null;
  return record;
}

// #642 (Q33c): once per conversation, when a reply's prompt filled 90% or
// more of the context window, the sentence Mana adds at the end of that
// reply; "" otherwise. promptTokens is llama-server's own count.
const CONTEXT_FULL_NOTE =
  "By the way, this chat is getting pretty full. Starting a fresh one would help me keep track.";
function contextFullNote(sessionId, promptTokens, contextSize) {
  const key = String(sessionId || "default");
  if (!(Number(contextSize) > 0) || !(promptTokens / contextSize >= 0.9)) return "";
  if (fullNoteSessions.has(key)) return "";
  fullNoteSessions.add(key);
  return CONTEXT_FULL_NOTE;
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
    fullNoteSessions.clear();
    return;
  }
  compositionBySession.delete(String(sessionId));
  fullNoteSessions.delete(String(sessionId));
}

module.exports = {
  recordPromptComposition,
  finalizePromptComposition,
  contextFullNote,
  getPromptComposition,
  getMostRecentComposition,
  resetPromptCompositionReport,
};
