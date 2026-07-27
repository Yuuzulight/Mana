// Issue #159: catches Mana's own replies falling into a repetitive rut --
// a persona with a fixed set of verbal tics (kaomoji, catchphrases,
// sentence openers) is especially prone to this over a long session.
// Cheap text-level check (Jaccard over word n-grams), no embedding model
// needed, matching the `manneri` project's own approach this issue is
// modeled on.
const DEFAULT_EXCLUDE_KEYWORDS = [
  "yeah",
  "yep",
  "okay",
  "ok",
  "sure",
  "thanks",
  "thank you",
  "no",
  "yes",
  "lol",
  "haha",
];

function tokenize(text) {
  return String(text || "").toLowerCase().match(/[a-z0-9']+/g) || [];
}

function ngrams(tokens, n) {
  const result = [];
  for (let i = 0; i <= tokens.length - n; i += 1) {
    result.push(tokens.slice(i, i + n).join(" "));
  }
  return result;
}

function jaccardSimilarity(arrayA, arrayB) {
  if (!arrayA.length || !arrayB.length) return 0;
  const setA = new Set(arrayA);
  const setB = new Set(arrayB);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Falls back to unigram overlap when either text is too short to produce
// any n-grams at all (e.g. n=3 over a 2-word reply) -- otherwise two
// short-but-identical replies would always score 0 similarity just
// because neither has 3 tokens.
function computeNGramSimilarity(textA, textB, n = 3) {
  const tokensA = tokenize(textA);
  const tokensB = tokenize(textB);
  const gramsA = ngrams(tokensA, n);
  const gramsB = ngrams(tokensB, n);
  if (!gramsA.length || !gramsB.length) {
    return jaccardSimilarity(tokensA, tokensB);
  }
  return jaccardSimilarity(gramsA, gramsB);
}

// options.lookback: how many of Mana's recent replies to compare against.
// options.similarityThreshold: Jaccard score at/above which a candidate
// counts as a rut.
// options.cooldownReplies: how many replies to skip checking after an
// intervention fires, so breaking a rut doesn't trigger constant
// regeneration on ordinary back-and-forth conversation.
// options.minMessageLength / options.excludeKeywords: trivially short
// replies/exact acknowledgements never count as either a candidate or a
// comparison point -- "okay" matching a prior "okay" isn't a rut.
function createRutDetector(options = {}) {
  const lookback = options.lookback ?? 10;
  const similarityThreshold = options.similarityThreshold ?? 0.5;
  const cooldownReplies = options.cooldownReplies ?? 3;
  const minMessageLength = options.minMessageLength ?? 15;
  const excludeKeywords = (options.excludeKeywords ?? DEFAULT_EXCLUDE_KEYWORDS).map((w) =>
    w.toLowerCase(),
  );
  const cooldowns = new Map();

  function isExcluded(text) {
    const trimmed = String(text || "").trim();
    if (trimmed.length < minMessageLength) return true;
    return excludeKeywords.includes(trimmed.toLowerCase());
  }

  function similarityAgainstRecent(candidateText, recentReplies) {
    if (isExcluded(candidateText)) return 0;
    const relevant = (recentReplies || [])
      .filter((r) => !isExcluded(r))
      .slice(-lookback);
    let max = 0;
    for (const prior of relevant) {
      const similarity = computeNGramSimilarity(candidateText, prior);
      if (similarity > max) max = similarity;
    }
    return max;
  }

  // Returns true (and consumes one tick) if the session was on cooldown --
  // the caller should skip the rut check entirely for this reply. Called
  // exactly once per "a reply is being finalized" decision, never per
  // individual candidate compared, so a Best-of-N pass with several
  // candidates doesn't burn through the cooldown counter in one turn.
  function consumeCooldownTick(sessionId) {
    const remaining = cooldowns.get(sessionId) || 0;
    if (remaining > 0) {
      cooldowns.set(sessionId, remaining - 1);
      return true;
    }
    return false;
  }

  function recordIntervention(sessionId) {
    cooldowns.set(sessionId, cooldownReplies);
  }

  // General single-reply path (any mode, not just Best-of-N): is this
  // reply too similar to what Mana's already said recently?
  function checkReply(sessionId, replyText, recentReplies) {
    if (consumeCooldownTick(sessionId)) {
      return { isRut: false, similarity: 0, onCooldown: true };
    }
    const similarity = similarityAgainstRecent(replyText, recentReplies);
    return { isRut: similarity >= similarityThreshold, similarity, onCooldown: false };
  }

  // Best-of-N path: Best-of-N already pays for N candidates, so rather
  // than trusting the judge's pick blindly or paying for a whole extra
  // regeneration call, prefer whichever already-generated candidate
  // scores lowest against recent history. Only falls through to
  // `needsRegeneration: true` when every candidate on hand is a rut.
  function pickLeastRepetitive(sessionId, candidates, judgeIndex, recentReplies) {
    if (consumeCooldownTick(sessionId)) {
      return { content: candidates[judgeIndex], index: judgeIndex, switched: false, onCooldown: true };
    }

    const scored = candidates.map((text, i) => ({
      text,
      i,
      similarity: similarityAgainstRecent(text, recentReplies),
    }));
    const judged = scored[judgeIndex];
    if (judged.similarity < similarityThreshold) {
      return { content: judged.text, index: judgeIndex, switched: false, onCooldown: false, similarity: judged.similarity };
    }

    const alternatives = scored
      .filter((c) => c.i !== judgeIndex && c.similarity < similarityThreshold)
      .sort((a, b) => a.similarity - b.similarity);
    if (alternatives.length) {
      const best = alternatives[0];
      recordIntervention(sessionId);
      return { content: best.text, index: best.i, switched: true, onCooldown: false, similarity: best.similarity };
    }

    return {
      content: judged.text,
      index: judgeIndex,
      switched: false,
      onCooldown: false,
      similarity: judged.similarity,
      needsRegeneration: true,
    };
  }

  return {
    isExcluded,
    computeSimilarity: similarityAgainstRecent,
    checkReply,
    pickLeastRepetitive,
    recordIntervention,
  };
}

module.exports = { computeNGramSimilarity, createRutDetector, DEFAULT_EXCLUDE_KEYWORDS };
