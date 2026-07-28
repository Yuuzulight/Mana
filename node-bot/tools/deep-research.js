// Deep Research: a multi-step research flow built on top of the existing
// single-shot web-access tools (search + read). Given a question, it
// optionally decomposes it into a few distinct sub-queries, searches each,
// pools + dedupes the results, reads a bounded number of them, and asks the
// local model to synthesize a cited report -- rather than a single
// search-and-answer.
const { searchWeb: defaultSearchWeb, fetchPage: defaultFetchPage } = require("./web-access");
const { runWithBoundedConcurrency, DEFAULT_MAX_CONCURRENCY } = require("./subagent-delegation");

const DEFAULT_MAX_SOURCES = 4;
const MAX_SOURCES_CAP = 8;
const DEFAULT_MAX_TOTAL_MS = 60000;
const MAX_TOTAL_MS_CAP = 180000;
const MAX_EXCERPT_CHARS = 2000;
const DEFAULT_MAX_SUB_QUERIES = 3;
const MAX_SUB_QUERIES_CAP = 4;
const DEFAULT_MAX_PER_DOMAIN = 2;
const MAX_PER_DOMAIN_CAP = MAX_SOURCES_CAP;
const MAX_CONCURRENCY_CAP = 5;
// Issue #197: how many extra search-reflect-synthesize cycles are allowed
// beyond the initial pass. Small and capped on purpose -- this is meant to
// close one genuine, named gap the model itself flagged, not turn into an
// open-ended research loop with no bound.
const DEFAULT_MAX_REFLECT_CYCLES = 1;
const MAX_REFLECT_CYCLES_CAP = 2;

const NO_GAP_MARKER = "NONE";
// Issue #197: reuses the existing gap-detection instinct already baked
// into RESEARCH_SYSTEM_PROMPT's "Note:" line, but as a structured decision
// (a follow-up query or NONE) instead of free text glued onto the report.
const REFLECT_SYSTEM_PROMPT =
  `You are reviewing a research report for a genuine gap: a question the ` +
  `sources didn't answer, a real disagreement between sources, or an ` +
  `obviously outdated source with no more recent one to check against. ` +
  `If you find one, reply with exactly one line: a single, specific web ` +
  `search query that would find a source to close that gap. If the report ` +
  `is already sufficient, reply with exactly "${NO_GAP_MARKER}" and ` +
  `nothing else. Never invent a gap just to have something to say.`;

// Issue #208: condenses each newly-read source's raw excerpt down to what's
// actually relevant to the research question, instead of the flat
// MAX_EXCERPT_CHARS position-cut every source got before. One batched call
// per cycle covers every source read in that cycle, not one call per source.
const COMPRESS_SYSTEM_PROMPT =
  `You condense research source excerpts. For each numbered source, keep ` +
  `only the sentences relevant to the research question and drop the ` +
  `rest -- do not add commentary or facts not present in the excerpt. ` +
  `Reply with one block per source in the exact format "[N] condensed ` +
  `excerpt", one per line-separated source, nothing else.`;

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

function clampMaxConcurrency(value) {
  const n = Number(value);
  const safe =
    Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_MAX_CONCURRENCY;
  return Math.min(Math.max(safe, 1), MAX_CONCURRENCY_CAP);
}

function clampMaxReflectCycles(value) {
  const n = Number(value);
  const safe =
    Number.isFinite(n) && n >= 0 ? Math.round(n) : DEFAULT_MAX_REFLECT_CYCLES;
  return Math.min(Math.max(safe, 0), MAX_REFLECT_CYCLES_CAP);
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

function buildCompressPrompt(question, newSources) {
  const sourceBlocks = newSources.map(
    (s) => `[${s.index}] ${s.title || "(untitled)"}\nURL: ${s.url}\n${s.excerpt}`,
  );
  return [`Research question: ${question}`, "", "Sources:", ...sourceBlocks].join(
    "\n\n",
  );
}

// Parses "[N] condensed excerpt" blocks back into a Map<index, text>. A
// source whose index doesn't appear in the response (partial/malformed
// reply) simply keeps its original excerpt at the call site -- same
// "degrade, don't break" philosophy as parseSubQueries/parseReflectDecision.
function parseCompressedExcerpts(text) {
  const map = new Map();
  const raw = String(text || "");
  const matches = [...raw.matchAll(/^\[(\d+)\]\s*/gm)];
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : raw.length;
    const index = Number(matches[i][1]);
    const excerpt = raw.slice(start, end).trim();
    if (index && excerpt) map.set(index, excerpt);
  }
  return map;
}

function buildReflectPrompt(question, report) {
  return [`Research question: ${question}`, "", "Current report:", report].join(
    "\n\n",
  );
}

// Returns null when the model reports no gap (or the response can't be
// read as a plausible single search query) -- a malformed or chatty
// response is treated the same as "no gap" rather than risking a garbage
// query, matching parseSubQueries' own "silently degrade" philosophy.
function parseReflectDecision(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed || trimmed.toUpperCase() === NO_GAP_MARKER) return null;
  const firstLine = trimmed.split(/\r?\n/)[0].trim();
  if (!firstLine || firstLine.length > 200) return null;
  return firstLine;
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
  const maxConcurrency = clampMaxConcurrency(options.maxConcurrency);
  const decompose =
    typeof options.decompose === "function" ? options.decompose : null;
  // Issue #208: optional, same injected-dependency shape as decompose/reflect
  // -- this module stays unaware of which LLM/profile actually condenses
  // excerpts.
  const compress =
    typeof options.compress === "function" ? options.compress : null;
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

  // Steps 2+3: search a set of queries, pooling/deduping results, then read
  // the new ones concurrently. Extracted into a reusable closure (issue
  // #197) so the reflect loop below can run the exact same search-then-read
  // logic for one follow-up query, instead of duplicating it -- citation
  // numbering continues from sources.length rather than restarting, and
  // each source is tagged with which cycle (0 = initial, 1+ = reflect)
  // found it.
  const pooled = [];
  const seenUrls = new Set();
  const domainCounts = new Map();
  const searchErrors = [];
  const sources = [];
  let hitTimeLimit = false;
  let hitSourceLimit = false;

  async function searchAndRead(queriesToRun, cycle) {
    // Step 2: search each query, pooling results and deduping by URL. A
    // per-domain cap keeps the pool from being dominated by several pages
    // of the same site (e.g. three Reddit threads), so the reader actually
    // gets multiple perspectives. Results whose URL doesn't parse are
    // never capped.
    const newlyPooled = [];
    for (let qi = 0; qi < queriesToRun.length; qi += 1) {
      if (elapsed() >= maxTotalMs) {
        hitTimeLimit = true;
        break;
      }
      throwIfCancelled();
      onProgress({
        step: "searching",
        label:
          queriesToRun.length > 1
            ? `Searching (${qi + 1} of ${queriesToRun.length}): "${queriesToRun[qi]}"...`
            : `Searching for "${queriesToRun[qi]}"...`,
        index: qi + 1,
        total: queriesToRun.length,
      });

      let results = [];
      try {
        results = await search(queriesToRun[qi], { limit: maxSources });
      } catch (e) {
        // One failing sub-search shouldn't sink the pass; only give up if
        // every search failed (checked below, cycle 0 only).
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
        newlyPooled.push(result);
      }
    }

    if (
      cycle === 0 &&
      !pooled.length &&
      searchErrors.length === queriesToRun.length &&
      searchErrors.length
    ) {
      throw searchErrors[0];
    }

    if (pooled.length > maxSources) hitSourceLimit = true;

    // Step 3 (issue #145): read the newly pooled sources concurrently,
    // capped by maxConcurrency -- each read is fully independent of the
    // others (a different URL, no shared state), the clearest case of
    // parallelizable sub-work in this pipeline. Each task checks
    // cancellation for itself right before starting its own read -- a
    // global check before the whole batch wouldn't stop tasks that
    // haven't started their read yet once isCancelled() flips true
    // partway through (worker slots pick up the next task as soon as
    // they free up, same as a sequential loop checked between each
    // iteration).
    throwIfCancelled();
    const toRead = newlyPooled.slice(0, maxSources);
    if (!toRead.length) return 0;
    if (elapsed() >= maxTotalMs) {
      hitTimeLimit = true;
      return 0;
    }

    const startIndex = sources.length;
    const localResults = new Array(toRead.length);
    const readTasks = toRead.map((result, i) => async () => {
      throwIfCancelled();
      try {
        const page = await read(result.url);
        return {
          index: startIndex + i + 1,
          url: page.url,
          title: page.title || result.title,
          excerpt: page.text.slice(0, MAX_EXCERPT_CHARS),
          readFailed: false,
          cycle,
        };
      } catch (e) {
        if (e instanceof ResearchCancelledError) throw e;
        // A single unreadable source shouldn't sink the whole research pass
        // -- fall back to the search snippet so it's still citable.
        return {
          index: startIndex + i + 1,
          url: result.url,
          title: result.title,
          excerpt: result.snippet,
          readFailed: true,
          cycle,
        };
      }
    });

    const settledResults = await runWithBoundedConcurrency(readTasks, {
      maxConcurrency,
      onTaskSettled: (i, settled) => {
        if (!settled.ok) return; // cancellation -- surfaced below
        localResults[i] = settled.value;
        onProgress({
          step: "reading",
          label: `Reading source ${startIndex + i + 1} of ${startIndex + toRead.length}...`,
          index: startIndex + i + 1,
          total: startIndex + toRead.length,
          url: toRead[i].url,
        });
      },
    });

    const cancelled = settledResults.find(
      (r) => !r.ok && r.error instanceof ResearchCancelledError,
    );
    if (cancelled) throw cancelled.error;

    const added = localResults.filter(Boolean);

    // Issue #208: condense the excerpts just read, one batched call
    // covering every source from this cycle rather than one call per
    // source. A failing/unavailable compressor must never sink the
    // research pass -- sources simply keep their original (flat-truncated)
    // excerpt, same resilience philosophy as decompose/reflect above.
    if (compress && added.length) {
      throwIfCancelled();
      try {
        const raw = await compress(buildCompressPrompt(cleanQuestion, added));
        const compressed = parseCompressedExcerpts(raw);
        for (const s of added) {
          const c = compressed.get(s.index);
          if (c) s.excerpt = c;
        }
      } catch (e) {
        if (e instanceof ResearchCancelledError) throw e;
      }
    }

    sources.push(...added);
    return added.length;
  }

  await searchAndRead(queries, 0);

  if (elapsed() >= maxTotalMs) {
    hitTimeLimit = true;
  }
  throwIfCancelled();
  onProgress({ step: "synthesizing", label: "Synthesizing report..." });

  let report = sources.length
    ? await options.synthesize(buildResearchPrompt(cleanQuestion, sources))
    : "No sources could be found or read for this question.";

  // Issue #197: reflect on the synthesized report for a genuine, named gap
  // and -- if the caller opted in and one is found -- run one more bounded
  // search-read-synthesize cycle to close it. Never runs by default
  // (options.reflect is opt-in, same pattern as options.decompose) and
  // never loops more than maxReflectCycles times regardless of what the
  // model keeps claiming needs closing.
  const reflect =
    typeof options.reflect === "function" ? options.reflect : null;
  const maxReflectCycles = clampMaxReflectCycles(options.maxReflectCycles);
  let reflectCycles = 0;
  if (reflect && sources.length && maxReflectCycles > 0) {
    for (let cycle = 1; cycle <= maxReflectCycles; cycle += 1) {
      if (elapsed() >= maxTotalMs) {
        hitTimeLimit = true;
        break;
      }
      throwIfCancelled();
      onProgress({ step: "reflecting", label: "Checking for gaps..." });

      let gapQuery = null;
      try {
        const raw = await reflect(buildReflectPrompt(cleanQuestion, report));
        gapQuery = parseReflectDecision(raw);
      } catch (e) {
        // A failing reflect call must never sink an already-good report --
        // just stop cycling, same resilience philosophy as decompose above.
        gapQuery = null;
      }
      if (!gapQuery) break;

      throwIfCancelled();
      const added = await searchAndRead([gapQuery], cycle);
      if (!added) break; // nothing new found for the flagged gap
      reflectCycles = cycle;

      if (elapsed() >= maxTotalMs) {
        hitTimeLimit = true;
        break;
      }
      throwIfCancelled();
      onProgress({ step: "synthesizing", label: "Synthesizing updated report..." });
      report = await options.synthesize(buildResearchPrompt(cleanQuestion, sources));
    }
  }

  onProgress({ step: "done", label: "Research complete." });

  return {
    question: cleanQuestion,
    subQueries,
    sources: sources.map(({ index, url, title, readFailed, cycle }) => ({
      index,
      url,
      title,
      readFailed,
      cycle,
    })),
    report,
    bounds: {
      maxSources,
      maxTotalMs,
      maxSubQueries,
      maxPerDomain,
      maxConcurrency,
      maxReflectCycles,
      reflectCycles,
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
  DEFAULT_MAX_CONCURRENCY,
  MAX_CONCURRENCY_CAP,
  DEFAULT_MAX_REFLECT_CYCLES,
  MAX_REFLECT_CYCLES_CAP,
  NO_GAP_MARKER,
  RESEARCH_SYSTEM_PROMPT,
  SUB_QUERY_SYSTEM_PROMPT,
  REFLECT_SYSTEM_PROMPT,
  COMPRESS_SYSTEM_PROMPT,
  ResearchCancelledError,
  buildResearchPrompt,
  buildSubQueryPrompt,
  buildReflectPrompt,
  buildCompressPrompt,
  parseSubQueries,
  parseReflectDecision,
  parseCompressedExcerpts,
  runDeepResearch,
};
