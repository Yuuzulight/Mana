// Deep Research: a multi-step research flow built on top of the existing
// single-shot web-access tools (search + read). Given a question, it
// searches, reads a bounded number of the results, and asks the local model
// to synthesize a cited report -- rather than a single search-and-answer.
const { searchWeb: defaultSearchWeb, fetchPage: defaultFetchPage } = require("./web-access");

const DEFAULT_MAX_SOURCES = 4;
const MAX_SOURCES_CAP = 8;
const DEFAULT_MAX_TOTAL_MS = 60000;
const MAX_TOTAL_MS_CAP = 180000;
const MAX_EXCERPT_CHARS = 2000;

const RESEARCH_SYSTEM_PROMPT =
  "You are a careful research assistant. You are given a research question " +
  "and excerpts from several web sources, each labeled with a number and its " +
  "URL. Write a structured summary that directly answers the question, " +
  "citing sources inline like [1] or [2] matching the provided numbering. " +
  "Do not invent URLs or facts that are not present in the sources. If the " +
  "sources are insufficient or conflicting, say so plainly instead of " +
  "guessing.";

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

function buildResearchPrompt(question, sources) {
  const sourceBlocks = sources.map(
    (s) => `[${s.index}] ${s.title || "(untitled)"}\nURL: ${s.url}\n${s.excerpt}`,
  );
  return [`Research question: ${question}`, "", "Sources:", ...sourceBlocks].join(
    "\n\n",
  );
}

// options.synthesize: required, (prompt) => Promise<string>. Kept as an
// injected dependency rather than importing the LLM reply pipeline directly,
// so this module has no knowledge of which local model/profile is used --
// that's the caller's (capability layer's) job.
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
  const search = options.searchWeb || defaultSearchWeb;
  const read = options.fetchPage || defaultFetchPage;
  const onProgress = options.onProgress || (() => {});
  const nowMs = options.nowMs || (() => Date.now());
  const startedAt = nowMs();
  const elapsed = () => nowMs() - startedAt;

  onProgress({
    step: "searching",
    label: `Searching for "${cleanQuestion}"...`,
  });
  const searchResults = await search(cleanQuestion, { limit: maxSources });
  const consideredCount = Math.min(searchResults.length, maxSources);
  const hitSourceLimit = searchResults.length > maxSources;

  const sources = [];
  let hitTimeLimit = false;
  for (let i = 0; i < consideredCount; i += 1) {
    if (elapsed() >= maxTotalMs) {
      hitTimeLimit = true;
      break;
    }

    const result = searchResults[i];
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

  onProgress({ step: "synthesizing", label: "Synthesizing report..." });

  const report = sources.length
    ? await options.synthesize(buildResearchPrompt(cleanQuestion, sources))
    : "No sources could be found or read for this question.";

  onProgress({ step: "done", label: "Research complete." });

  return {
    question: cleanQuestion,
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
  RESEARCH_SYSTEM_PROMPT,
  buildResearchPrompt,
  runDeepResearch,
};
