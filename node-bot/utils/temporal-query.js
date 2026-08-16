// Issue #337: "what did we talk about yesterday" and "what do you know
// about my job" are different questions. The first is answered by
// filtering on time and reading in time order; the second by ranking on
// relevance. Run through one undifferentiated path, one of the two always
// answers badly -- a relevance-ranked answer to a time question returns
// the right topic from the wrong day.
//
// This pulls the time window out of a query when one is stated, so the
// caller can filter first and let relevance rank inside the window.
//
// Deliberately a closed set of expressions matched literally rather than a
// general date parser or a model call: the entire value here is being
// cheap and predictable enough to run on every single query. An expression
// this does not recognize simply yields null and the query stays purely
// topical, which is the existing behavior.
const DAY_MS = 24 * 60 * 60 * 1000;

// Boundaries are computed in local time, then expressed as ISO for
// comparison against the stored `at` (which is UTC). "Yesterday" means the
// user's yesterday, not UTC's.
function startOfLocalDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

// Ordered most-specific first. "last week" is tested before "this week" so
// the shared word cannot let the wrong branch win.
// Each entry reports the text it actually matched, not just a label. The
// two differ -- "this morning" is labelled "today" -- and it is the matched
// text that has to come out of the residual query, or the phrase stays in
// and FTS goes looking for it in the stored turn.
function matchWindow(lower, todayStart, tomorrowStart) {
  const daysAgo = lower.match(/\b(\d{1,2}) days? ago\b/);
  if (daysAgo) {
    const start = new Date(todayStart.getTime() - Number(daysAgo[1]) * DAY_MS);
    return {
      start,
      end: new Date(start.getTime() + DAY_MS),
      label: daysAgo[0],
      matchedText: daysAgo[0],
    };
  }
  // "last night" and "yesterday" collapse to the same calendar day. Keeping
  // them apart would mean guessing where the user's evening starts, which
  // buys nothing for recall.
  const yesterdayish = lower.match(/\blast night\b|\byesterday\b/);
  if (yesterdayish) {
    return {
      start: new Date(todayStart.getTime() - DAY_MS),
      end: todayStart,
      label: "yesterday",
      matchedText: yesterdayish[0],
    };
  }
  const todayish = lower.match(/\btoday\b|\bthis (?:morning|afternoon|evening)\b/);
  if (todayish) {
    return { start: todayStart, end: tomorrowStart, label: "today", matchedText: todayish[0] };
  }
  const lastWeek = lower.match(/\blast week\b/);
  if (lastWeek) {
    return {
      start: new Date(todayStart.getTime() - 7 * DAY_MS),
      end: todayStart,
      label: "last week",
      matchedText: lastWeek[0],
    };
  }
  const thisWeek = lower.match(/\bthis week\b/);
  if (thisWeek) {
    return {
      start: new Date(todayStart.getTime() - 7 * DAY_MS),
      end: tomorrowStart,
      label: "this week",
      matchedText: thisWeek[0],
    };
  }
  const lastMonth = lower.match(/\blast month\b/);
  if (lastMonth) {
    return {
      start: new Date(todayStart.getTime() - 30 * DAY_MS),
      end: todayStart,
      label: "last month",
      matchedText: lastMonth[0],
    };
  }
  return null;
}

// Returns null when the text states no time window, or
// { since, until, label, residualQuery }.
//
// residualQuery is the query with the date expression removed. This matters:
// left in, "yesterday" becomes an FTS keyword and the search then requires
// the literal word to appear in the stored message, which is exactly what
// it does not do -- the turn says "the deploy broke", not "yesterday the
// deploy broke". It can come back empty, which means the question was
// purely temporal and the caller should filter on time alone.
function parseTemporalWindow(text, now = new Date()) {
  const raw = String(text || "");
  const lower = raw.toLowerCase();
  const todayStart = startOfLocalDay(now);
  const tomorrowStart = new Date(todayStart.getTime() + DAY_MS);

  const matched = matchWindow(lower, todayStart, tomorrowStart);
  if (!matched) return null;

  const residualQuery = raw
    .replace(new RegExp(matched.matchedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    since: matched.start.toISOString(),
    until: matched.end.toISOString(),
    label: matched.label,
    residualQuery,
  };
}

module.exports = { parseTemporalWindow };
