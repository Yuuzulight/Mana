// Issue #272: the attention-gate half of ambient screen-sensing -- pure,
// no I/O, no image data ever touches this file (the plugin's route layer
// in index.js hands it only the derived text summary, already discarded
// the raw screenshot by the time this runs). Decides whether a periodic
// glance is worth proactively interrupting the user with, inspired by
// Miru's (github.com/kiyotakali/Miru) "glance, summarize, discard, then
// gate" shape.
const SUMMARY_PROMPT =
  "In one short sentence, describe what the user currently appears to be doing on screen -- their apparent activity or focus, not exact on-screen text or UI details.";

function significantWords(text) {
  return [...new Set(String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3))];
}

// Cheap word-overlap ratio, same style as acp-memory-store.js's
// findConflictingFact -- good enough to tell "same activity, nothing
// changed" from "genuinely different scene" without needing another model
// call per glance.
function similarity(a, b) {
  const wordsA = significantWords(a);
  const wordsB = significantWords(b);
  if (!wordsA.length || !wordsB.length) return 0;
  const overlap = wordsA.filter((word) => wordsB.includes(word)).length;
  return overlap / Math.min(wordsA.length, wordsB.length);
}

// options.cooldownMs: minimum time between two *surfaced* interruptions --
// default 5 minutes, deliberately not configurable per-request (that would
// let a single misbehaving caller spam interruptions).
// options.similarityThreshold: how much word-overlap between this glance
// and the immediately previous one counts as "nothing meaningfully
// changed" and gets skipped.
// options.minSummaryChars: guards against surfacing a near-empty/failed
// vision summary.
function createAttentionGate(options = {}) {
  const now = options.now || (() => Date.now());
  const cooldownMs = options.cooldownMs === undefined ? 5 * 60 * 1000 : options.cooldownMs;
  const similarityThreshold =
    options.similarityThreshold === undefined ? 0.6 : options.similarityThreshold;
  const minSummaryChars = options.minSummaryChars === undefined ? 8 : options.minSummaryChars;

  let lastGlanceSummary = "";
  let lastSurfacedAt = 0;

  // decide() is called once per glance, whether or not it ends up
  // surfacing -- lastGlanceSummary always advances so "did anything change"
  // compares consecutive glances, while lastSurfacedAt only advances on an
  // actual surface so the cooldown only throttles real interruptions, not
  // the quiet glances in between.
  function decide(summary, context = {}) {
    const text = String(summary || "").trim();
    const previousGlance = lastGlanceSummary;
    lastGlanceSummary = text;

    if (context.gamingModeActive) {
      return { shouldSurface: false, reason: "gaming-mode-active" };
    }
    if (text.length < minSummaryChars) {
      return { shouldSurface: false, reason: "summary-too-short" };
    }
    if (previousGlance && similarity(text, previousGlance) >= similarityThreshold) {
      return { shouldSurface: false, reason: "no-meaningful-change" };
    }
    if (lastSurfacedAt && now() - lastSurfacedAt < cooldownMs) {
      return { shouldSurface: false, reason: "cooldown" };
    }

    lastSurfacedAt = now();
    return { shouldSurface: true, reason: "new" };
  }

  return { decide };
}

module.exports = { SUMMARY_PROMPT, createAttentionGate, similarity };
