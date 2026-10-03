// Issue #392: a research report is exactly the output where a confident
// wrong attribution does the most damage, because it looks verified. An
// unsourced summary is honest about being a summary; one carrying an
// invented source is worse than either.
//
// Mana runs small local models, which invent citations more readily than
// large ones, so this is not a theoretical concern here.
//
// The check is deliberately mechanical. It compares what the report claims
// against what the run actually fetched -- no model judges its own work,
// which is the same reasoning as #356: whatever a model got wrong while
// writing, it tends to consider fine while checking.

// Citation markers the research prompt itself establishes: sources are
// presented to the model as "[1] Title / URL: ...", so a reference back is
// expected in the same form.
const CITATION_RE = /\[(\d{1,3})\]/g;
// Bare URLs in prose. Deliberately loose: the point is to catch a URL the
// model produced from nowhere, so over-matching costs a check and
// under-matching costs the finding.
const URL_RE = /https?:\/\/[^\s<>()[\]"']+/g;

function normalizeUrl(url) {
  const trimmed = String(url || "").trim().replace(/[.,;:]+$/, "");
  try {
    const parsed = new URL(trimmed);
    // Trailing slash and fragment are not identity -- the same page cited
    // with and without one is the same fetch.
    parsed.hash = "";
    const normalized = parsed.toString();
    return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  } catch (e) {
    return trimmed;
  }
}

// sources: the run's own record, as returned by deep-research -- each with
// an index, a url, and whether reading it actually succeeded.
function checkCitations(report, sources = []) {
  const text = String(report || "");
  const byIndex = new Map();
  const fetched = new Set();
  for (const source of sources) {
    if (!source) continue;
    byIndex.set(Number(source.index), source);
    // A source that failed to read was never actually seen, so citing it is
    // the same class of problem as citing one that does not exist.
    if (!source.readFailed && source.url) fetched.add(normalizeUrl(source.url));
  }

  const citedIndexes = [...new Set([...text.matchAll(CITATION_RE)].map((m) => Number(m[1])))];
  const unknownIndexes = citedIndexes.filter((i) => !byIndex.has(i));
  const unreadIndexes = citedIndexes.filter((i) => byIndex.get(i)?.readFailed);

  const citedUrls = [...new Set([...text.matchAll(URL_RE)].map((m) => normalizeUrl(m[0])))];
  const unfetchedUrls = citedUrls.filter((u) => !fetched.has(u));

  // Sources the run paid to fetch and the report never used. Not a
  // correctness problem, but it is the signal that a report is thinner than
  // the work behind it.
  const usedIndexes = new Set(citedIndexes);
  const unusedIndexes = [...byIndex.keys()].filter(
    (i) => !usedIndexes.has(i) && !byIndex.get(i)?.readFailed,
  );

  // Issue #1329: Citations are checked against fetched text.
  // Unsupported claims don't get a citation.
  const unsupportedCitations = [];
  const matches = [...text.matchAll(/\[(\d{1,3})\](?:\([^)]*\))?/g)];
  for (const match of matches) {
    const idx = Number(match[1]);
    const src = byIndex.get(idx);
    if (src && !src.readFailed && (src.text || src.snippet)) {
      const claim = extractClaimText(text, match.index, match[0].length);
      if (!isClaimSupported(claim, src)) {
        unsupportedCitations.push({ index: idx, claim });
      }
    }
  }

  return {
    ok:
      unknownIndexes.length === 0 &&
      unreadIndexes.length === 0 &&
      unfetchedUrls.length === 0 &&
      unsupportedCitations.length === 0,
    citedIndexes,
    unknownIndexes,
    unreadIndexes,
    unfetchedUrls,
    unusedIndexes,
    unsupportedCitations,
  };
}

const STOP_WORDS = new Set([
  "the", "and", "that", "have", "for", "not", "with", "you", "this", "but",
  "his", "from", "they", "say", "her", "she", "will", "one", "all", "would",
  "there", "their", "what", "out", "about", "who", "get", "which", "when",
  "make", "can", "like", "time", "just", "him", "know", "take", "people",
  "into", "year", "your", "good", "some", "could", "them", "see", "other",
  "than", "then", "now", "look", "only", "come", "its", "over", "think",
  "also", "back", "after", "use", "two", "how", "our", "work", "first",
  "well", "way", "even", "new", "want", "because", "any", "these", "give",
  "day", "most", "us", "are", "was", "were", "been", "has", "had", "does",
  "did", "may", "might", "must", "should", "shall",
]);

function extractClaimText(fullText, matchIndex, matchLength) {
  const before = fullText.slice(0, matchIndex);
  const lastDelim = Math.max(
    before.lastIndexOf("."),
    before.lastIndexOf("!"),
    before.lastIndexOf("?"),
    before.lastIndexOf("\n"),
  );
  const start = lastDelim >= 0 ? lastDelim + 1 : 0;
  const after = fullText.slice(matchIndex + matchLength);
  const nextDelimRel = after.search(/[.!?\n]/);
  const end = nextDelimRel >= 0 ? matchIndex + matchLength + nextDelimRel : fullText.length;
  return fullText.slice(start, end).replace(/\[\d+\](?:\([^)]*\))?/g, "").trim();
}

function isClaimSupported(claim, source) {
  if (!source) return false;
  if (source.readFailed) return false;
  const sourceCorpus = [source.title, source.snippet, source.text]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!sourceCorpus.trim()) return true;

  const words = (claim.toLowerCase().match(/\b[a-z0-9_-]{3,}\b/g) || []).filter(
    (w) => !STOP_WORDS.has(w),
  );
  if (words.length === 0) return true;

  const matched = words.filter((w) => sourceCorpus.includes(w));
  if (matched.length === 0) return false;
  if (words.length >= 3 && matched.length / words.length < 0.2) return false;
  return true;
}

// Issue #1329: filters out citations that are unknown, unread, or unsupported,
// formats verified citations as markdown links [N](url), and returns the
// verified sources list.
function verifyAndFilterCitations(text, sources = []) {
  const raw = String(text || "");
  const byIndex = new Map();
  for (const source of sources) {
    if (!source) continue;
    byIndex.set(Number(source.index), source);
  }

  const validCitedIndexes = new Set();
  const regex = /\[(\d{1,3})\](?:\([^)]*\))?/g;
  let filtered = raw.replace(regex, (match, indexStr, offset) => {
    const index = Number(indexStr);
    const source = byIndex.get(index);
    if (!source || source.readFailed) {
      return "";
    }
    const claim = extractClaimText(raw, offset, match.length);
    if (!isClaimSupported(claim, source)) {
      return "";
    }
    validCitedIndexes.add(index);
    return source.url ? `[${index}](${source.url})` : `[${index}]`;
  });

  filtered = filtered
    .replace(/[ \t]+([.,!?;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ");

  const verifiedSources = sources
    .filter((s) => s && validCitedIndexes.has(Number(s.index)))
    .map((s) => ({
      index: Number(s.index),
      title: s.title || s.url || `Source ${s.index}`,
      url: s.url,
    }));

  return {
    text: filtered,
    sources: verifiedSources,
    citedIndexes: [...validCitedIndexes].sort((a, b) => a - b),
  };
}

module.exports = {
  checkCitations,
  extractClaimText,
  isClaimSupported,
  normalizeUrl,
  verifyAndFilterCitations,
};
