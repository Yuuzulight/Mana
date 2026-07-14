const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_MAX_SOURCES,
  MAX_SOURCES_CAP,
  MAX_TOTAL_MS_CAP,
  ResearchCancelledError,
  buildResearchPrompt,
  parseSubQueries,
  runDeepResearch,
} = require("../tools/deep-research");

function fakeSearchResults(count) {
  return Array.from({ length: count }, (_, i) => ({
    title: `Result ${i + 1}`,
    url: `https://example.com/${i + 1}`,
    snippet: `Snippet ${i + 1}`,
  }));
}

test("runDeepResearch searches, reads bounded sources, and synthesizes a cited report", async () => {
  const progress = [];
  const synthCalls = [];

  const result = await runDeepResearch("what is the capital of France?", {
    maxSources: 2,
    searchWeb: async (query, options) => {
      assert.equal(query, "what is the capital of France?");
      assert.equal(options.limit, 2);
      return fakeSearchResults(3); // more than maxSources, to test clamping
    },
    fetchPage: async (url) => ({
      url,
      title: `Title for ${url}`,
      text: `Full page text for ${url}`.repeat(10),
    }),
    synthesize: async (prompt) => {
      synthCalls.push(prompt);
      return "Paris is the capital of France [1].";
    },
    onProgress: (p) => progress.push(p),
  });

  assert.equal(result.question, "what is the capital of France?");
  assert.equal(result.sources.length, 2, "should stop at maxSources even though 3 results were returned");
  assert.deepEqual(result.sources[0], {
    index: 1,
    url: "https://example.com/1",
    title: "Title for https://example.com/1",
    readFailed: false,
  });
  assert.equal(result.report, "Paris is the capital of France [1].");
  assert.equal(result.bounds.maxSources, 2);
  assert.equal(result.bounds.sourcesUsed, 2);
  assert.equal(result.bounds.hitTimeLimit, false);
  assert.equal(result.bounds.hitSourceLimit, true, "3 results found but only 2 allowed");

  assert.equal(synthCalls.length, 1);
  assert.match(synthCalls[0], /\[1\] Title for https:\/\/example\.com\/1/);
  assert.match(synthCalls[0], /\[2\] Title for https:\/\/example\.com\/2/);

  const steps = progress.map((p) => p.step);
  assert.deepEqual(steps, ["searching", "reading", "reading", "synthesizing", "done"]);
});

test("runDeepResearch falls back to the search snippet when a page fails to load", async () => {
  const result = await runDeepResearch("test question", {
    maxSources: 2,
    searchWeb: async () => fakeSearchResults(2),
    fetchPage: async (url) => {
      if (url.endsWith("/1")) {
        throw new Error("fetch failed");
      }
      return { url, title: "OK title", text: "ok text" };
    },
    synthesize: async () => "report",
  });

  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].readFailed, true);
  assert.equal(result.sources[0].title, "Result 1"); // snippet's title, not a fetched one
  assert.equal(result.sources[1].readFailed, false);
});

test("runDeepResearch stops early when the time budget is exhausted", async () => {
  let callCount = 0;
  let clock = 0;
  const result = await runDeepResearch("slow question", {
    maxSources: 5,
    maxTotalMs: 5000,
    nowMs: () => {
      // First call establishes startedAt; each subsequent elapsed() check
      // advances the clock past the budget after the first source.
      clock += 10000;
      return clock;
    },
    searchWeb: async () => fakeSearchResults(5),
    fetchPage: async (url) => {
      callCount += 1;
      return { url, title: "t", text: "x" };
    },
    synthesize: async () => "partial report",
  });

  assert.equal(callCount, 0, "time budget should already be exhausted before the first read");
  assert.equal(result.bounds.hitTimeLimit, true);
  assert.equal(result.bounds.sourcesUsed, 0);
  assert.equal(result.report, "No sources could be found or read for this question.");
});

test("runDeepResearch clamps maxSources and maxTotalMs to their documented bounds", async () => {
  const seen = {};
  await runDeepResearch("q", {
    maxSources: 999,
    maxTotalMs: 999999999,
    searchWeb: async (q, options) => {
      seen.limit = options.limit;
      return [];
    },
    synthesize: async () => "report",
  });
  assert.equal(seen.limit, MAX_SOURCES_CAP);

  const withDefaults = await runDeepResearch("q2", {
    searchWeb: async (q, options) => {
      seen.defaultLimit = options.limit;
      return [];
    },
    synthesize: async () => "report",
  });
  assert.equal(seen.defaultLimit, DEFAULT_MAX_SOURCES);
  assert.equal(withDefaults.bounds.maxTotalMs <= MAX_TOTAL_MS_CAP, true);
});

test("runDeepResearch requires a question and a synthesize function", async () => {
  await assert.rejects(() => runDeepResearch(""), /question is required/);
  await assert.rejects(
    () => runDeepResearch("q", {}),
    /synthesize function is required/,
  );
});

test("parseSubQueries strips numbering/bullets, dedupes, drops commentary, and caps the count", () => {
  const raw = [
    "Here are the queries:",
    "1. RTX 5080 VRAM specs",
    "- RTX 5080 release price",
    "* RTX 5080 vram SPECS", // dupe of #1 modulo case
    "2) RTX 5080 benchmarks",
    "RTX 5080 availability",
    "x".repeat(300), // too long to be a query
  ].join("\n");

  assert.deepEqual(parseSubQueries(raw, 3), [
    "RTX 5080 VRAM specs",
    "RTX 5080 release price",
    "RTX 5080 benchmarks",
  ]);
  assert.deepEqual(parseSubQueries("", 3), []);
});

test("runDeepResearch decomposes into sub-queries, searches each, and dedupes pooled results", async () => {
  const progress = [];
  const searchedQueries = [];

  const result = await runDeepResearch("compare X and Y", {
    maxSources: 4,
    maxSubQueries: 3,
    decompose: async (prompt) => {
      assert.match(prompt, /Research question: compare X and Y/);
      return "1. what is X\n2. what is Y\n";
    },
    searchWeb: async (query) => {
      searchedQueries.push(query);
      // Both searches return an overlapping URL to exercise dedupe.
      return [
        { title: "Shared", url: "https://example.com/shared", snippet: "s" },
        { title: query, url: `https://example.com/${searchedQueries.length}`, snippet: "s" },
      ];
    },
    fetchPage: async (url) => ({ url, title: `T ${url}`, text: "text" }),
    synthesize: async () => "report",
    onProgress: (p) => progress.push(p),
  });

  assert.deepEqual(searchedQueries, ["what is X", "what is Y"]);
  assert.deepEqual(result.subQueries, ["what is X", "what is Y"]);
  assert.deepEqual(
    result.sources.map((s) => s.url),
    ["https://example.com/shared", "https://example.com/1", "https://example.com/2"],
    "the shared URL should appear once despite being returned by both searches",
  );

  const steps = progress.map((p) => p.step);
  assert.deepEqual(steps, [
    "planning",
    "searching",
    "searching",
    "reading",
    "reading",
    "reading",
    "synthesizing",
    "done",
  ]);
  assert.match(progress[1].label, /Searching \(1 of 2\)/);
});

test("runDeepResearch falls back to a single query when decompose fails or returns nothing", async () => {
  const searchedQueries = [];
  const base = {
    maxSources: 1,
    searchWeb: async (query) => {
      searchedQueries.push(query);
      return fakeSearchResults(1);
    },
    fetchPage: async (url) => ({ url, title: "t", text: "x" }),
    synthesize: async () => "report",
  };

  const failed = await runDeepResearch("q1", {
    ...base,
    decompose: async () => {
      throw new Error("model unavailable");
    },
  });
  assert.deepEqual(failed.subQueries, []);

  const empty = await runDeepResearch("q2", {
    ...base,
    decompose: async () => "Here are the queries:\n",
  });
  assert.deepEqual(empty.subQueries, []);

  assert.deepEqual(searchedQueries, ["q1", "q2"]);
});

test("runDeepResearch tolerates one failing sub-search but throws when every search fails", async () => {
  const tolerated = await runDeepResearch("q", {
    decompose: async () => "alpha\nbeta",
    searchWeb: async (query) => {
      if (query === "alpha") {
        throw new Error("SearXNG hiccup");
      }
      return fakeSearchResults(1);
    },
    fetchPage: async (url) => ({ url, title: "t", text: "x" }),
    synthesize: async () => "report",
  });
  assert.equal(tolerated.sources.length, 1);

  await assert.rejects(
    () =>
      runDeepResearch("q", {
        decompose: async () => "alpha\nbeta",
        searchWeb: async () => {
          throw new Error("SearXNG down");
        },
        synthesize: async () => "unused",
      }),
    /SearXNG down/,
  );
});

test("runDeepResearch stops with ResearchCancelledError when isCancelled flips true", async () => {
  let reads = 0;
  await assert.rejects(
    () =>
      runDeepResearch("q", {
        maxSources: 3,
        searchWeb: async () => fakeSearchResults(3),
        fetchPage: async (url) => {
          reads += 1;
          return { url, title: "t", text: "x" };
        },
        synthesize: async () => "unused",
        // Cancel after the first read completes.
        isCancelled: () => reads >= 1,
      }),
    (error) => error instanceof ResearchCancelledError,
  );
  assert.equal(reads, 1, "cancellation should stop before the second read");
});

test("buildResearchPrompt numbers sources and includes the question", () => {
  const prompt = buildResearchPrompt("why is the sky blue?", [
    { index: 1, url: "https://a.com", title: "A", excerpt: "excerpt a" },
    { index: 2, url: "https://b.com", title: "B", excerpt: "excerpt b" },
  ]);
  assert.match(prompt, /Research question: why is the sky blue\?/);
  assert.match(prompt, /\[1\] A\nURL: https:\/\/a\.com\nexcerpt a/);
  assert.match(prompt, /\[2\] B\nURL: https:\/\/b\.com\nexcerpt b/);
});
