const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_MAX_SOURCES,
  MAX_SOURCES_CAP,
  MAX_TOTAL_MS_CAP,
  buildResearchPrompt,
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

test("buildResearchPrompt numbers sources and includes the question", () => {
  const prompt = buildResearchPrompt("why is the sky blue?", [
    { index: 1, url: "https://a.com", title: "A", excerpt: "excerpt a" },
    { index: 2, url: "https://b.com", title: "B", excerpt: "excerpt b" },
  ]);
  assert.match(prompt, /Research question: why is the sky blue\?/);
  assert.match(prompt, /\[1\] A\nURL: https:\/\/a\.com\nexcerpt a/);
  assert.match(prompt, /\[2\] B\nURL: https:\/\/b\.com\nexcerpt b/);
});
