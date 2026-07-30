const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

// Issue #269 pass 5's finding: this flag has the most substantial known
// caveat of this review round (a confirmed net-loss swap-cost tradeoff, see
// docs/roadmap/issue-269-deep-research-subtask-profiles.md) yet had zero
// test coverage. DEEP_RESEARCH_SUBTASK_PROFILE is computed once at module
// load from process.env, so proving the off-by-default behavior means
// re-requiring server.js fresh with the env var unset/set, not just
// re-reading the source.
const SERVER_PATH = path.join(__dirname, "..", "server.js");

function requireServerWithEnv(envValue) {
  delete require.cache[require.resolve(SERVER_PATH)];
  const previous = process.env.MANA_DEEP_RESEARCH_SUBTASK_PROFILES;
  if (envValue === undefined) delete process.env.MANA_DEEP_RESEARCH_SUBTASK_PROFILES;
  else process.env.MANA_DEEP_RESEARCH_SUBTASK_PROFILES = envValue;
  try {
    return require(SERVER_PATH);
  } finally {
    if (previous === undefined) delete process.env.MANA_DEEP_RESEARCH_SUBTASK_PROFILES;
    else process.env.MANA_DEEP_RESEARCH_SUBTASK_PROFILES = previous;
    delete require.cache[require.resolve(SERVER_PATH)];
  }
}

test("DEEP_RESEARCH_SUBTASK_PROFILE resolves to \"quality\" (matching prior behavior) when the env var is unset", () => {
  const { DEEP_RESEARCH_SUBTASK_PROFILE } = requireServerWithEnv(undefined);
  assert.equal(DEEP_RESEARCH_SUBTASK_PROFILE, "quality");
});

test("DEEP_RESEARCH_SUBTASK_PROFILE resolves to \"fast\" only when explicitly opted in via MANA_DEEP_RESEARCH_SUBTASK_PROFILES=1", () => {
  const { DEEP_RESEARCH_SUBTASK_PROFILE } = requireServerWithEnv("1");
  assert.equal(DEEP_RESEARCH_SUBTASK_PROFILE, "fast");
});

test("DEEP_RESEARCH_SUBTASK_PROFILE stays \"quality\" for any value other than the exact string \"1\"", () => {
  assert.equal(requireServerWithEnv("true").DEEP_RESEARCH_SUBTASK_PROFILE, "quality");
  assert.equal(requireServerWithEnv("yes").DEEP_RESEARCH_SUBTASK_PROFILE, "quality");
});
