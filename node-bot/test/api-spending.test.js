// #1406: API spending -- tokens by kind, dollars at peak and off-peak,
// totals by day, month, model and use, kept across restarts.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createApiSpending, createBalanceReader, runway, createSpendingToolSource, isPeak, nextOffPeak, tokensOf, costOf, describeUsage } = require("../api-spending");

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

test("dollars by token kind add up to the total, and the daily series covers the last 30 days", () => {
  const s = createApiSpending({ file: tmpFile(), now: () => OFF });
  s.record({ model: "deepseek-flash", use: "self-work", usage, at: OFF });
  s.record({ model: "deepseek-v4-pro", use: "chat", usage, at: PEAK });
  s.record({ model: "deepseek-flash", use: "bench", usage, at: new Date("2026-09-30T12:00:00Z") });
  const sum = s.summary();
  const t = sum.today;
  // Flash off-peak: 1M hit, 1M miss, 600k answer + 400k reasoning at the output price.
  const f = sum.today.byModel["deepseek-flash"];
  assert.ok(Math.abs(f.usdCacheHit - 0.003) < 1e-9 && Math.abs(f.usdCacheMiss - 0.15) < 1e-9);
  assert.ok(Math.abs(f.usdOutput - 0.36) < 1e-9 && Math.abs(f.usdReasoning - 0.24) < 1e-9);
  assert.ok(Math.abs(t.usdCacheHit + t.usdCacheMiss + t.usdOutput + t.usdReasoning - t.usd) < 1e-9);
  assert.equal(sum.daily.length, 30);
  assert.equal(sum.daily.at(-1).day, "2026-10-07");
  assert.equal(sum.daily[0].day, "2026-09-08");
  assert.ok(Math.abs(sum.daily.at(-1).byModel["deepseek-v4-pro"] - 2 * (0.022 + 0.66 + 1.98)) < 1e-9);
  assert.ok(Math.abs(sum.daily.find((d) => d.day === "2026-09-30").usd - (0.003 + 0.15 + 0.6)) < 1e-9);
  assert.equal(sum.daily[1].usd, 0);
  assert.equal(s.summary({ days: 7 }).daily.length, 7);
});

test("issues: what each cost with its outcome, the cost per merged PR, and each day's issues", () => {
  const s = createApiSpending({ file: tmpFile(), now: () => OFF });
  s.record({ model: "deepseek-flash", use: "self-work", usage, at: OFF, issue: 12 });
  s.record({ model: "deepseek-flash", use: "self-work", usage, at: OFF, issue: 12 });
  s.record({ model: "deepseek-flash", use: "self-work", usage, at: OFF, issue: 13 });
  s.record({ model: "deepseek-flash", use: "chat", usage, at: OFF });
  const flash = 0.003 + 0.15 + 0.6;
  const outcomes = { 12: { title: "Fix the tray", state: "merged", prs: [900] }, 13: { title: "Speed up recall", state: "exhausted", prs: [] } };
  const sum = s.summary({ outcomeOf: (n) => outcomes[n] });
  assert.deepEqual(sum.results.top.map((i) => [i.issue, i.title, i.state, i.requests]), [[12, "Fix the tray", "merged", 2], [13, "Speed up recall", "exhausted", 1]]);
  assert.equal(sum.results.mergedPrs, 1);
  assert.ok(Math.abs(sum.results.costPerMergedPr - 2 * flash) < 1e-9);
  assert.ok(Math.abs(sum.results.usdOnHeld - flash) < 1e-9);
  const today = sum.daily.at(-1);
  assert.deepEqual(today.issues.map((i) => i.issue), [12, 13]);
  assert.ok(Math.abs(today.byUse["self-work"] - 3 * flash) < 1e-9 && Math.abs(today.byUse.chat - flash) < 1e-9);
});

test("peak surcharge, cache hit rate, last month and this month's projection", () => {
  const s = createApiSpending({ file: tmpFile(), now: () => OFF });
  s.record({ model: "deepseek-flash", use: "chat", usage, at: PEAK });
  s.record({ model: "deepseek-flash", use: "chat", usage, at: OFF });
  s.record({ model: "deepseek-flash", use: "chat", usage, at: new Date("2026-09-15T12:00:00Z") });
  const sum = s.summary();
  const flash = 0.003 + 0.15 + 0.6;
  assert.ok(Math.abs(sum.today.usdPeakExtra - flash) < 1e-9, "the peak request's extra is half its double price");
  assert.ok(Math.abs(sum.daily.at(-1).peakExtra - flash) < 1e-9);
  assert.equal(sum.today.cacheHitRate, 0.5);
  assert.ok(Math.abs(sum.lastMonth.usd - flash) < 1e-9);
  // 3 x flash spent by the 7th of a 31-day month.
  assert.ok(Math.abs(sum.month.projected - (3 * flash / 7) * 31) < 1e-9);
  // Sep 15 is outside the last 14 days.
  assert.ok(Math.abs(sum.avgDaily - 3 * flash / 14) < 1e-9);
});

test("the DeepSeek balance: read with the key, cached, never in local-only; runway in days", async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    assert.equal(url, "https://api.deepseek.test/user/balance");
    assert.equal(init.headers.Authorization, "Bearer sk-test");
    return { ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "50.00" }, { currency: "USD", total_balance: "7.40", granted_balance: "0.00", topped_up_balance: "7.40" }] }) };
  };
  let t = 0;
  const settings = () => ({ baseUrl: "https://api.deepseek.test/", apiKey: "sk-test" });
  const read = createBalanceReader({ settings, fetchImpl, env: {}, now: () => t });
  assert.deepEqual(await read(), { currency: "USD", total: 7.4, granted: 0, toppedUp: 7.4, available: true });
  t = 60 * 1000;
  await read();
  assert.equal(calls, 1, "cached for 5 minutes");
  t = 6 * 60 * 1000;
  await read();
  assert.equal(calls, 2);
  assert.equal(await createBalanceReader({ settings, fetchImpl, env: { MANA_LOCAL_ONLY: "1" } })(), null);
  assert.equal(await createBalanceReader({ settings: () => ({ apiKey: "" }), fetchImpl, env: {} })(), null);
  const failing = createBalanceReader({ settings, fetchImpl: async () => ({ ok: false, status: 401 }), env: {} });
  assert.match((await failing()).error, /401/);

  assert.deepEqual(runway({ currency: "USD", total: 7.4 }, 0.2), { daysLeft: 37, low: false });
  assert.equal(runway({ currency: "USD", total: 1.2 }, 0.3).low, true);
  assert.equal(runway({ currency: "USD", total: 0.5 }, 0).low, true);
  assert.equal(runway({ currency: "CNY", total: 50 }, 0.3), null);
});

test("her chat tool reads the same summary", async () => {
  const s = createApiSpending({ file: tmpFile(), now: () => OFF });
  s.record({ model: "deepseek-flash", use: "chat", usage, at: OFF });
  const tool = createSpendingToolSource(async () => s.summary({ days: 7 }));
  assert.equal(tool.isKnownToolName("api_spending__summary"), true);
  const out = JSON.parse(await tool.executeTool("api_spending__summary"));
  assert.equal(out.today.requests, 1);
});
