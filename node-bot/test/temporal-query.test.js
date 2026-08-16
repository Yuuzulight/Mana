const assert = require("node:assert/strict");
const test = require("node:test");

const { parseTemporalWindow } = require("../utils/temporal-query");

// Fixed reference point so the windows are deterministic: local noon.
const NOW = new Date(2026, 7, 17, 12, 0, 0);

test("returns null when the text states no time window", () => {
  assert.equal(parseTemporalWindow("what do you know about my job", NOW), null);
  assert.equal(parseTemporalWindow("", NOW), null);
  assert.equal(parseTemporalWindow(undefined, NOW), null);
});

test("yesterday resolves to the previous calendar day", () => {
  const w = parseTemporalWindow("what did we discuss yesterday", NOW);
  assert.equal(w.label, "yesterday");
  assert.equal(new Date(w.since).getDate(), 16);
  assert.equal(new Date(w.until).getDate(), 17);
});

test("the date expression is stripped from the residual query", () => {
  const w = parseTemporalWindow("the deploy we talked about yesterday", NOW);
  // Left in, FTS would require the literal word "yesterday" in the turn.
  assert.doesNotMatch(w.residualQuery, /yesterday/i);
  assert.match(w.residualQuery, /deploy/);
});

test("a purely temporal question leaves an empty residual query", () => {
  const w = parseTemporalWindow("yesterday", NOW);
  assert.equal(w.residualQuery, "");
});

test("last week is tested before this week despite the shared word", () => {
  assert.equal(parseTemporalWindow("last week", NOW).label, "last week");
  assert.equal(parseTemporalWindow("this week", NOW).label, "this week");
});

test("N days ago resolves to that single day", () => {
  const w = parseTemporalWindow("the bug from 3 days ago", NOW);
  assert.equal(new Date(w.since).getDate(), 14);
  assert.equal(new Date(w.until).getDate(), 15);
});

test("windows are half-open so adjacent days cannot both claim midnight", () => {
  const yesterday = parseTemporalWindow("yesterday", NOW);
  const today = parseTemporalWindow("today", NOW);
  assert.equal(yesterday.until, today.since);
});

test("a phrase labelled differently from its text is still stripped (issue #337)", () => {
  const w = parseTemporalWindow("what did we decide this morning about caching", NOW);
  // Labelled "today", but the text says "this morning" -- it is the matched
  // text that has to come out, or FTS goes looking for the phrase.
  assert.equal(w.label, "today");
  assert.doesNotMatch(w.residualQuery, /this morning/i);
  assert.match(w.residualQuery, /caching/);
});

test("last night strips its own wording, not the yesterday label (issue #337)", () => {
  const w = parseTemporalWindow("the crash last night", NOW);
  assert.equal(w.label, "yesterday");
  assert.doesNotMatch(w.residualQuery, /last night/i);
  assert.match(w.residualQuery, /crash/);
});
