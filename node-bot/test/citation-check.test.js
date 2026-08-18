const assert = require("node:assert/strict");
const test = require("node:test");

const { checkCitations, normalizeUrl } = require("../utils/citation-check");

const SOURCES = [
  { index: 1, url: "https://example.test/a", title: "A" },
  { index: 2, url: "https://example.test/b", title: "B" },
  { index: 3, url: "https://example.test/c", title: "C", readFailed: true },
];

test("a report citing only real, read sources passes", () => {
  const result = checkCitations("Claim one [1]. Claim two [2].", SOURCES);
  assert.equal(result.ok, true);
  assert.deepEqual(result.citedIndexes, [1, 2]);
  assert.deepEqual(result.unknownIndexes, []);
});

test("a citation index that does not exist is caught", () => {
  const result = checkCitations("Confident claim [7].", SOURCES);
  assert.equal(result.ok, false);
  assert.deepEqual(result.unknownIndexes, [7]);
});

test("citing a source that failed to read is caught", () => {
  // Never actually seen, so citing it is the same class of problem as
  // citing one that does not exist.
  const result = checkCitations("According to [3], something.", SOURCES);
  assert.equal(result.ok, false);
  assert.deepEqual(result.unreadIndexes, [3]);
});

test("a URL the run never fetched is caught", () => {
  const result = checkCitations(
    "See https://invented.test/page for details.",
    SOURCES,
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.unfetchedUrls, ["https://invented.test/page"]);
});

test("a fetched URL quoted in prose is accepted", () => {
  const result = checkCitations("As https://example.test/a explains, ...", SOURCES);
  assert.equal(result.ok, true);
  assert.deepEqual(result.unfetchedUrls, []);
});

test("trailing punctuation and slashes do not make a real URL look invented", () => {
  const result = checkCitations("Per https://example.test/a/, it holds.", SOURCES);
  assert.deepEqual(result.unfetchedUrls, []);
});

test("sources the report never used are reported separately", () => {
  const result = checkCitations("Only one claim [1].", SOURCES);
  // Not a correctness problem -- the signal that a report is thinner than
  // the work behind it. The failed source is not counted as unused.
  assert.deepEqual(result.unusedIndexes, [2]);
  assert.equal(result.ok, true);
});

test("an empty report cites nothing and is not an error", () => {
  const result = checkCitations("", SOURCES);
  assert.equal(result.ok, true);
  assert.deepEqual(result.citedIndexes, []);
});

test("normalizeUrl treats fragment and trailing slash as the same page", () => {
  assert.equal(
    normalizeUrl("https://example.test/a/#section"),
    normalizeUrl("https://example.test/a"),
  );
});
