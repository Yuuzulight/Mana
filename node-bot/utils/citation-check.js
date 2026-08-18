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

  return {
    ok: unknownIndexes.length === 0 && unreadIndexes.length === 0 && unfetchedUrls.length === 0,
    citedIndexes,
    unknownIndexes,
    unreadIndexes,
    unfetchedUrls,
    unusedIndexes,
  };
}

module.exports = { checkCitations, normalizeUrl };
