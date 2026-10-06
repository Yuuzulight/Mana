// #1406: API spending -- tokens by kind, dollars at peak and off-peak,
// totals by day, month, model and use, kept across restarts.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createApiSpending, createSpendingToolSource, isPeak, nextOffPeak, tokensOf, costOf, describeUsage } = require("../api-spending");

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mana-spending-")), "api-spending.json");
// DeepSeek's usage block for 1M hit, 1M miss, 1M out of which 400k reasoning.
const usage = {
  prompt_tokens: 2_000_000,
  prompt_cache_hit_tokens: 1_000_000,
  prompt_cache_miss_tokens: 1_000_000,
  completion_tokens: 1_000_000,
  completion_tokens_details: { reasoning_tokens: 400_000 },
};
// Wednesday 2026-10-07: 02:00 UTC is peak (10:00 SGT), 12:00 UTC is off-peak.
const PEAK = new Date("2026-10-07T02:00:00Z");
const OFF = new Date("2026-10-07T12:00:00Z");

test("peak is DeepSeek's weekday windows in UTC; weekends are off-peak", () => {
  assert.equal(isPeak(PEAK), true);
  assert.equal(isPeak(new Date("2026-10-07T04:00:00Z")), false, "04:00 ends the first window");
  assert.equal(isPeak(new Date("2026-10-07T09:59:00Z")), true);
  assert.equal(isPeak(OFF), false);
  assert.equal(isPeak(new Date("2026-10-10T02:00:00Z")), false, "Saturday");
  assert.equal(nextOffPeak(new Date("2026-10-07T07:30:00Z")).toISOString(), "2026-10-07T10:00:00.000Z");
  assert.equal(nextOffPeak(OFF).getTime(), OFF.getTime());
});

test("tokens by kind and dollars: reasoning is part of output, peak doubles", () => {
  const t = tokensOf(usage);
  assert.deepEqual(t, { cacheHit: 1_000_000, cacheMiss: 1_000_000, output: 1_000_000, reasoning: 400_000 });
  assert.equal(costOf("deepseek-flash", t, false), 0.003 + 0.15 + 0.6);
  assert.equal(costOf("deepseek-flash", t, true), 2 * (0.003 + 0.15 + 0.6));
  assert.equal(costOf("some-other-model", t, false), null);
  // A provider with only the OpenAI-style cached count.
  assert.deepEqual(tokensOf({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens: 5 }), { cacheHit: 60, cacheMiss: 40, output: 5, reasoning: 0 });
  assert.equal(describeUsage({ ...t, usd: 0.753 }), "2000k in (1000k cached), 1000k out (400k reasoning), $0.75");
});

test("totals by period, model and use survive a restart; a broken file starts fresh", () => {
  const file = tmpFile();
  let at = PEAK;
  const s = createApiSpending({ file, now: () => at });
  const peakRun = s.record({ model: "deepseek-v4-pro", use: "self-work", usage, at: PEAK });
  assert.equal(peakRun.peak, true);
  s.record({ model: "deepseek-flash", use: "chat", usage, at: OFF });
  s.record({ model: "deepseek-flash", use: "bench", usage, at: new Date("2026-09-30T12:00:00Z") });
  s.record({ model: "mystery", use: "chat", usage: { prompt_tokens: 10, completion_tokens: 1 }, at: OFF });
  assert.throws(() => s.record({ model: "deepseek-flash", use: "games", usage }), /unknown API use/);

  at = OFF;
  const sum = createApiSpending({ file, now: () => at }).summary();
  const flash = 0.003 + 0.15 + 0.6;
  const pro = 2 * (0.022 + 0.66 + 1.98);
  assert.equal(sum.total.requests, 4);
  assert.ok(Math.abs(sum.total.usd - (pro + 2 * flash)) < 1e-9);
  assert.ok(Math.abs(sum.today.usd - (pro + flash)) < 1e-9);
  assert.equal(sum.month.requests, 3, "September's bench run isn't this month");
  assert.equal(sum.today.byUse.chat.requests, 2);
  assert.equal(sum.today.byUse.chat.unpricedRequests, 1);
  assert.equal(sum.total.byModel["deepseek-flash"].reasoning, 800_000);
  assert.equal(sum.total.byUse.bench.output, 1_000_000);
  assert.equal(sum.peakNow, false);

  fs.writeFileSync(file, "{ broken");
  assert.equal(createApiSpending({ file }).summary().total.requests, 0);
});

test("her chat tool reads the same summary", async () => {
  const s = createApiSpending({ file: tmpFile(), now: () => OFF });
  s.record({ model: "deepseek-flash", use: "chat", usage, at: OFF });
  const tool = createSpendingToolSource(s);
  assert.equal(tool.isKnownToolName("api_spending__summary"), true);
  const out = JSON.parse(await tool.executeTool("api_spending__summary"));
  assert.equal(out.today.requests, 1);
});
