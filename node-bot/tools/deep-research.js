// Deep Research: a multi-step research flow built on top of the existing
// single-shot web-access tools (search + read). Given a question, it
// optionally decomposes it into a few distinct sub-queries, searches each,
// pools + dedupes the results, reads a bounded number of them, and asks the
// local model to synthesize a cited report -- rather than a single
// search-and-answer.
const { searchWeb: defaultSearchWeb, fetchPage: defaultFetchPage } = require("./web-access");

const DEFAULT_MAX_SOURCES = 4;
const MAX_SOURCES_CAP = 8;
const DEFAULT_MAX_TOTAL_MS = 60000;
const MAX_TOTAL_MS_CAP = 180000;
const MAX_EXCERPT_CHARS = 2000;
const DEFAULT_MAX_SUB_QUERIES = 3;
const MAX_SUB_QUERIES_CAP = 4;
const DEFAULT_MAX_PER_DOMAIN = 2;
const MAX_PER_DOMAIN_CAP = MAX_SOURCES_CAP;

// Issue #77: the trailing "Note:" line is deliberately conditional -- only
// meaningfully-stale/incomplete/conflicting sources should trigger it, never
// a generic disclaimer glued onto every report.
const RESEARCH_SYSTEM_PROMPT =
  "You are a careful research assistant. You are given a research question " +
  "and excerpts from several web sources, each labeled with a number and its " +
  "URL. Write a structured summary that directly answers the question, " +
  "citing sources inline like [1] or [2] matching the provided numbering. " +
  "Do not invent URLs or facts that are not present in the sources.\n\n" +
  "Before you finish, check: do any two sources give a different answer, " +
  "does any source look outdated relative to another, or is there an " +
  "obvious gap the sources don't cover? If so, you must end your summary " +
  "with a line starting with \"Note:\" that names the specific sources and " +
  "the specific disagreement, date gap, or missing coverage -- do not just " +
  "silently pick the newer or more confident-sounding source. If the " +
  "sources are clean, consistent, and sufficient, skip the Note line " +
  "entirely -- never add a generic disclaimer to every answer.";

const SUB_QUERY_SYSTEM_PROMPT =
  "You split a research question into short, self-contained web search " +
  "queries that together cover its distinct aspects. Reply with one query " +
  "per line and nothing else -- no numbering, no bullets, no commentary.";

// Thrown between steps when the caller's isCancelled() flips true. Note the
// individual awaited operations (a page fetch, the synthesis LLM call) are
// not aborted mid-flight -- cancellation takes effect at the next step
// boundary after the in-flight operation settles.
class ResearchCancelledError extends Error {
  constructor() {
    super("research cancelled");
    this.name = "ResearchCancelledError";
  }
}

function clampMaxSources(value) {
  const n = Number(value);
  const safe = Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_MAX_SOURCES;
  return Math.min(Math.max(safe, 1), MAX_SOURCES_CAP);
}

function clampMaxTotalMs(value) {
  const n = Number(value);
  const safe = Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_MAX_TOTAL_MS;
  return Math.min(Math.max(safe, 5000), MAX_TOTAL_MS_CAP);
}

function clampMaxSubQueries(value) {
  const n = Number(value);
  const safe =
    Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_MAX_SUB_QUERIES;
  return Math.min(Math.max(safe, 1), MAX_SUB_QUERIES_CAP);
}

function clampMaxPerDomain(value) {
  const n = Number(value);
  const safe =
    Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_MAX_PER_DOMAIN;
  return Math.min(Math.max(safe, 1), MAX_PER_DOMAIN_CAP);
}

function hostnameOf(url) {
  try {
    return new URL(String(url || "")).hostname.toLowerCase();
  } catch (e) {
    return "";
  }
}

function buildSubQueryPrompt(question, maxQueries) {
  return [
    `Research question: ${question}`,
    "",
    `Write up to ${maxQueries} distinct web search queries that together cover this question. One query per line.`,
  ].join("\n");
}

function parseSubQueries(text, maxQueries) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    // Drop empties, commentary headers ("Here are the queries:"), and
    // anything too long to plausibly be a search query.
    .filter((line) => line && !/:$/.test(line) && line.length <= 200);

  const seen = new Set();
  const queries = [];
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(line);
    if (queries.length >= maxQueries) break;
  }
  return queries;
}

function buildResearchPrompt(question, sources) {
  const sourceBlocks = sources.map(
    (s) => `[${s.index}] ${s.title || "(untitled)"}\nURL: ${s.url}\n${s.excerpt}`,
  );
  return [`Research question: ${question}`, "", "Sources:", ...sourceBlocks].join(
    "\n\n",
  );
}

// options.synthesize: required, (prompt) => Promise<string>.
// options.decompose: optional, (prompt) => Promise<string> -- when provided,
//   the question is first split into sub-queries and each is searched.
// Both are injected dependencies rather than imports of the LLM reply
// pipeline, so this module has no knowledge of which local model/profile is
// used -- that's the caller's (capability layer's) job.
async function runDeepResearch(question, options = {}) {
  const cleanQuestion = String(question || "").trim();
  if (!cleanQuestion) {
    throw new Error("question is required");
  }
  if (typeof options.synthesize !== "function") {
    throw new Error("options.synthesize function is required");
  }

  const maxSources = clampMaxSources(options.maxSources);
  const maxTotalMs = clampMaxTotalMs(options.maxTotalMs);
  const maxSubQueries = clampMaxSubQueries(options.maxSubQueries);
  const maxPerDomain = clampMaxPerDomain(options.maxPerDomain);
  const decompose =
    typeof options.decompose === "function" ? options.decompose : null;
  const search = options.searchWeb || defaultSearchWeb;
  const read = options.fetchPage || defaultFetchPage;
  const onProgress = options.onProgress || (() => {});
  const isCancelled = options.isCancelled || (() => false);
  const nowMs = options.nowMs || (() => Date.now());
  const startedAt = nowMs();
  const elapsed = () => nowMs() - startedAt;
  const throwIfCancelled = () => {
    if (isCancelled()) {
      throw new ResearchCancelledError();
    }
  };

  // Step 1 (optional): decompose the question into sub-queries. Any failure
  // here silently falls back to single-query mode -- a research pass should
  // never die just because query planning did.
  let queries = [cleanQuestion];
  let subQueries = [];
  if (decompose && maxSubQueries > 1) {
    onProgress({ step: "planning", label: "Planning search queries..." });
    try {
      const raw = await decompose(
        buildSubQueryPrompt(cleanQuestion, maxSubQueries),
      );
      subQueries = parseSubQueries(raw, maxSubQueries);
      if (subQueries.length) {
        queries = subQueries;
      }
    } catch (e) {
      subQueries = [];
    }
  }
  throwIfCancelled();

  // Step 2: search each query, pooling results and deduping by URL. A
  // per-domain cap keeps the pool from being dominated by several pages of
  // the same site (e.g. three Reddit threads), so the reader actually gets
  // multiple perspectives. Results whose URL doesn't parse are never capped.
  const pooled = [];
  const seenUrls = new Set();
  const domainCounts = new Map();
  const searchErrors = [];
  let hitTimeLimit = false;
  for (let qi = 0; qi < queries.length; qi += 1) {
    if (elapsed() >= maxTotalMs) {
      hitTimeLimit = true;
      break;
    }
    throwIfCancelled();
    onProgress({
      step: "searching",
      label:
        queries.length > 1
          ? `Searching (${qi + 1} of ${queries.length}): "${queries[qi]}"...`
          : `Searching for "${queries[qi]}"...`,
      index: qi + 1,
      total: queries.length,
    });

    let results = [];
    try {
      results = await search(queries[qi], { limit: maxSources });
    } catch (e) {
      // One failing sub-search shouldn't sink the pass; only give up if
      // every search failed (checked below).
      searchErrors.push(e);
      continue;
    }
    for (const result of results) {
      const key = String(result.url || "").trim();
      if (!key || seenUrls.has(key)) continue;
      const hostname = hostnameOf(key);
      if (hostname) {
        const count = domainCounts.get(hostname) || 0;
        if (count >= maxPerDomain) continue;
        domainCounts.set(hostname, count + 1);
      }
      seenUrls.add(key);
      pooled.push(result);
    }
  }

  if (!pooled.length && searchErrors.length === queries.length && searchErrors.length) {
    throw searchErrors[0];
  }

  const consideredCount = Math.min(pooled.length, maxSources);
  const hitSourceLimit = pooled.length > maxSources;

  // Step 3: read the pooled sources, bounded by count and time.
  const sources = [];
  for (let i = 0; i < consideredCount; i += 1) {
    if (elapsed() >= maxTotalMs) {
      hitTimeLimit = true;
      break;
    }
    throwIfCancelled();

    const result = pooled[i];
    onProgress({
      step: "reading",
      label: `Reading source ${i + 1} of ${consideredCount}...`,
      index: i + 1,
      total: consideredCount,
      url: result.url,
    });

    try {
      const page = await read(result.url);
      sources.push({
        index: sources.length + 1,
        url: page.url,
        title: page.title || result.title,
        excerpt: page.text.slice(0, MAX_EXCERPT_CHARS),
        readFailed: false,
      });
    } catch (e) {
      // A single unreadable source shouldn't sink the whole research pass --
      // fall back to the search snippet so it's still citable.
      sources.push({
        index: sources.length + 1,
        url: result.url,
        title: result.title,
        excerpt: result.snippet,
        readFailed: true,
      });
    }
  }

  throwIfCancelled();
  onProgress({ step: "synthesizing", label: "Synthesizing report..." });

  const report = sources.length
    ? await options.synthesize(buildResearchPrompt(cleanQuestion, sources))
    : "No sources could be found or read for this question.";

  onProgress({ step: "done", label: "Research complete." });

  return {
    question: cleanQuestion,
    subQueries,
    sources: sources.map(({ index, url, title, readFailed }) => ({
      index,
      url,
      title,
      readFailed,
    })),
    report,
    bounds: {
      maxSources,
      maxTotalMs,
      maxSubQueries,
      maxPerDomain,
      sourcesUsed: sources.length,
      elapsedMs: elapsed(),
      hitTimeLimit,
      hitSourceLimit,
    },
  };
}

module.exports = {
  DEFAULT_MAX_SOURCES,
  MAX_SOURCES_CAP,
  DEFAULT_MAX_TOTAL_MS,
  MAX_TOTAL_MS_CAP,
  DEFAULT_MAX_SUB_QUERIES,
  MAX_SUB_QUERIES_CAP,
  DEFAULT_MAX_PER_DOMAIN,
  MAX_PER_DOMAIN_CAP,
  RESEARCH_SYSTEM_PROMPT,
  SUB_QUERY_SYSTEM_PROMPT,
  ResearchCancelledError,
  buildResearchPrompt,
  buildSubQueryPrompt,
  parseSubQueries,
  runDeepResearch,
};
