// #1406: what Mana's API use costs. One bucket per day, model and use
// (self-work, chat, bench) with its tokens (input from cache, input not
// from cache, output, and the reasoning part of output) and dollars. Kept
// in her data folder across restarts; never a prompt, code or key.
const fs = require("fs");
const path = require("path");

// Dollars per 1M tokens, off-peak; peak is double. From DeepSeek's pricing
// page (2026-10). Other models take the prices I set in Settings (#1441);
// a model with neither shows tokens only.
const PRICES = {
  "deepseek-flash": { hit: 0.003, miss: 0.15, out: 0.6 },
  "deepseek-v4-pro": { hit: 0.022, miss: 0.66, out: 1.98 },
};
const USES = ["self-work", "chat", "bench"];
const KINDS = ["cacheHit", "cacheMiss", "output", "reasoning"];

// DeepSeek's peak: 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday.
// ponytail: Chinese public holidays are off-peak but counted as peak here,
// so a holiday's cost reads high; add their calendar if that matters.
function isPeak(date = new Date()) {
  const day = date.getUTCDay();
  const h = date.getUTCHours();
  return day >= 1 && day <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
}

// The next off-peak moment at or after date.
function nextOffPeak(date = new Date()) {
  const t = new Date(date);
  while (isPeak(t)) t.setUTCMinutes(0, 0, 0), t.setUTCHours(t.getUTCHours() + 1);
  return t;
}

// An OpenAI-compatible usage block, in our token kinds.
function tokensOf(usage = {}) {
  const prompt = Number(usage.prompt_tokens) || 0;
  const hit = Number(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens) || 0;
  const miss = Number(usage.prompt_cache_miss_tokens) || Math.max(0, prompt - hit);
  return {
    cacheHit: hit,
    cacheMiss: miss,
    output: Number(usage.completion_tokens) || 0,
    reasoning: Number(usage.completion_tokens_details?.reasoning_tokens) || 0,
  };
}

// Dollars for those tokens, or null for a model without prices. Reasoning is
// part of output, so it isn't charged twice. price: one I set, for a model
// that isn't DeepSeek's.
function costOf(model, tokens, peak, price) {
  const parts = costParts(model, tokens, peak, price);
  return parts && parts.usdCacheHit + parts.usdCacheMiss + parts.usdOutput + parts.usdReasoning;
}

// The same dollars by token kind, for Settings' "where the money went":
// output here is the answer only; its reasoning part is billed at the same rate.
// Only DeepSeek's own prices double at its peak.
function costParts(model, tokens, peak, price) {
  const p = PRICES[model] || price;
  if (!p) return null;
  const m = (peak && PRICES[model] ? 2 : 1) / 1e6;
  return {
    usdCacheHit: tokens.cacheHit * p.hit * m,
    usdCacheMiss: tokens.cacheMiss * p.miss * m,
    usdOutput: (tokens.output - tokens.reasoning) * p.out * m,
    usdReasoning: tokens.reasoning * p.out * m,
  };
}
const USD_KINDS = ["usdCacheHit", "usdCacheMiss", "usdOutput", "usdReasoning"];
// Not part of usd's sum: what peak hours added to it.
const EXTRAS = ["usdPeakExtra"];

function emptyTotals() {
  return { requests: 0, usd: 0, unpricedRequests: 0, ...Object.fromEntries([...KINDS, ...USD_KINDS, ...EXTRAS].map((k) => [k, 0])) };
}

function add(into, b) {
  into.requests += b.requests;
  into.usd += b.usd;
  into.unpricedRequests += b.unpricedRequests;
  // A bucket from before the dollars were split counts as 0 there.
  for (const k of [...KINDS, ...USD_KINDS, ...EXTRAS]) into[k] += b[k] || 0;
}

function createApiSpending({ file, now = () => new Date() }) {
  let data = { version: 2, buckets: {}, issues: {}, issueDays: {}, prices: {} };
  try {
    if (fs.existsSync(file)) data = { ...data, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    // A broken file starts fresh rather than stopping her.
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
    fs.renameSync(`${file}.tmp`, file);
  }

  // One API response's usage, and the issue it was for when there is one
  // (self-work). Returns what it cost, for the run's own line.
  function record({ model, use, usage, at = now(), issue = null }) {
    if (!USES.includes(use)) throw new Error(`unknown API use: ${use}`);
    const tokens = tokensOf(usage);
    // DeepSeek's peak hours mean nothing to another provider's model.
    const peak = Boolean(PRICES[model]) && isPeak(at);
    const parts = costParts(model, tokens, peak, data.prices?.[model]);
    const usd = parts && USD_KINDS.reduce((sum, k) => sum + parts[k], 0);
    const day = at.toISOString().slice(0, 10);
    const b = (data.buckets[`${day}|${model}|${use}`] ||= emptyTotals());
    // What peak hours added: half of a peak request's price.
    add(b, { requests: 1, usd: usd ?? 0, unpricedRequests: usd === null ? 1 : 0, ...tokens, ...parts, usdPeakExtra: peak && usd ? usd / 2 : 0 });
    if (peak) b.peakRequests = (b.peakRequests || 0) + 1;
    const n = Number(issue);
    if (Number.isInteger(n) && n > 0) {
      const i = (data.issues[n] ||= { usd: 0, requests: 0, firstAt: at.toISOString() });
      i.usd += usd ?? 0;
      i.requests += 1;
      i.lastAt = at.toISOString();
      data.issueDays[`${day}|${n}`] = (data.issueDays[`${day}|${n}`] || 0) + (usd ?? 0);
    }
    save();
    return { ...tokens, usd, peak };
  }

  const dayOf = (offset) => new Date(now().getTime() - offset * 864e5).toISOString().slice(0, 10);

  function period(inPeriod) {
    const all = emptyTotals();
    const byModel = {};
    const byUse = {};
    for (const [key, b] of Object.entries(data.buckets)) {
      const [day, model, use] = key.split("|");
      if (!inPeriod(day)) continue;
      add(all, b);
      add((byModel[model] ||= emptyTotals()), b);
      add((byUse[use] ||= emptyTotals()), b);
    }
    const input = all.cacheHit + all.cacheMiss;
    return { ...all, cacheHitRate: input ? all.cacheHit / input : null, byModel, byUse };
  }

  // All-time, today, this month and last month (UTC), each split by model
  // and use; this month's projection; the last `days` days one by one (by
  // model, by use, the peak surcharge and the issues paid for); and what
  // each issue cost with its outcome from outcomeOf(issue) -> { title,
  // state, prs }, so the cost of a result shows.
  function summary({ days = 30, outcomeOf = null } = {}) {
    const today = dayOf(0);
    const month = today.slice(0, 7);
    const d = now();
    const lastMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    const out = {
      total: period(() => true),
      today: period((day) => day === today),
      month: period((day) => day.startsWith(month)),
      lastMonth: period((day) => day.startsWith(lastMonth)),
    };
    const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    out.month.projected = (out.month.usd / d.getUTCDate()) * daysInMonth;

    const daily = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const day = dayOf(i);
      const entry = { day, usd: 0, peakExtra: 0, byModel: {}, byUse: {}, issues: [] };
      for (const [key, b] of Object.entries(data.buckets)) {
        const [bd, model, use] = key.split("|");
        if (bd !== day) continue;
        entry.usd += b.usd;
        entry.peakExtra += b.usdPeakExtra || 0;
        entry.byModel[model] = (entry.byModel[model] || 0) + b.usd;
        entry.byUse[use] = (entry.byUse[use] || 0) + b.usd;
      }
      for (const [key, usd] of Object.entries(data.issueDays)) {
        const [bd, issue] = key.split("|");
        if (bd === day) entry.issues.push({ issue: Number(issue), usd, ...(outcomeOf?.(Number(issue)) || {}) });
      }
      entry.issues.sort((a, b) => b.usd - a.usd);
      daily.push(entry);
    }

    // The cost of results: what merged (or merged and verified) issues cost,
    // per PR that merged, and what went on issues now waiting on me.
    const issues = Object.entries(data.issues)
      .map(([n, i]) => ({ issue: Number(n), ...i, ...(outcomeOf?.(Number(n)) || {}) }))
      .sort((a, b) => b.usd - a.usd);
    const landed = issues.filter((i) => ["merged", "verified"].includes(i.state));
    const mergedPrs = landed.reduce((sum, i) => sum + Math.max(1, (i.prs || []).length), 0);
    const usdOnMerged = landed.reduce((sum, i) => sum + i.usd, 0);
    const results = {
      mergedPrs,
      usdOnMerged,
      costPerMergedPr: mergedPrs ? usdOnMerged / mergedPrs : null,
      usdOnHeld: issues.filter((i) => ["needs-you", "exhausted", "regressed"].includes(i.state)).reduce((sum, i) => sum + i.usd, 0),
      top: issues.slice(0, 10),
    };

    // Average over the last 14 days, for how long a balance lasts.
    const recent = daily.slice(-14);
    const avgDaily = recent.length ? recent.reduce((sum, x) => sum + x.usd, 0) / recent.length : 0;
    return { ...out, daily, results, avgDaily, peakNow: isPeak(now()), prices: { ...PRICES, ...(data.prices || {}) } };
  }

  // #1441: $ per 1M tokens I set for a model that isn't DeepSeek's: input,
  // output, and input from cache (input's price when not given). Null
  // removes it. Counts from now on; what she already spent stays tokens only.
  function setPrice(model, price) {
    const name = String(model || "").trim();
    if (!name || name.length > 200) throw new Error("a model name is needed");
    if (PRICES[name]) throw new Error(`${name}'s prices are built in`);
    data.prices ||= {};
    if (price === null) {
      delete data.prices[name];
    } else {
      const usd = (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 1000) throw new Error("a price is dollars per million tokens, 0 to 1000");
        return n;
      };
      const miss = usd(price?.in);
      data.prices[name] = { hit: price?.cachedIn === undefined || price?.cachedIn === null ? miss : usd(price.cachedIn), miss, out: usd(price?.out) };
    }
    save();
    return prices();
  }

  // The prices I set, and the models she used that have none, for Settings.
  function prices() {
    const unpriced = new Set();
    for (const [key, b] of Object.entries(data.buckets)) {
      const model = key.split("|")[1];
      if (b.unpricedRequests > 0 && !PRICES[model] && !data.prices?.[model]) unpriced.add(model);
    }
    return { set: { ...(data.prices || {}) }, unpriced: [...unpriced].sort() };
  }

  return { record, summary, setPrice, prices };
}

// #1406: the DeepSeek account's prepaid balance (GET /user/balance), read
// at most every 5 minutes with the key from Settings; never in local-only
// mode. runway() says how long it lasts at a daily average in dollars.
function createBalanceReader({ settings, fetchImpl = globalThis.fetch, env = process.env, now = () => Date.now(), ttlMs = 5 * 60 * 1000 }) {
  let cached = null;
  return async function balance() {
    const { isLocalOnly } = require("./local-only");
    const s = settings();
    if (isLocalOnly(env) || !s.apiKey) return null;
    if (cached && now() - cached.at < ttlMs) return cached.value;
    let value;
    try {
      const resp = await fetchImpl(`${String(s.baseUrl).replace(/\/+$/, "")}/user/balance`, {
        headers: { Authorization: `Bearer ${s.apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) throw new Error(`DeepSeek answered ${resp.status}`);
      const json = await resp.json();
      const info = (json.balance_infos || []).find((b) => b.currency === "USD") || (json.balance_infos || [])[0];
      if (!info) throw new Error("no balance in DeepSeek's answer");
      value = {
        currency: info.currency,
        total: Number(info.total_balance) || 0,
        granted: Number(info.granted_balance) || 0,
        toppedUp: Number(info.topped_up_balance) || 0,
        available: json.is_available !== false,
      };
    } catch (e) {
      value = { error: String(e.message || e).slice(0, 200) };
    }
    cached = { at: now(), value };
    return value;
  };
}

// Days a balance lasts at a daily average (dollars only); low under a week or $1.
function runway(balance, avgDaily) {
  if (!balance || balance.error || balance.currency !== "USD") return null;
  const daysLeft = avgDaily > 0 ? balance.total / avgDaily : null;
  return { daysLeft, low: balance.total < 1 || (daysLeft !== null && daysLeft < 7) };
}

// "412k in (380k cached), 31k out (12k reasoning), $0.04"
function describeUsage(t) {
  const k = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const usd = t.usd === null || t.usd === undefined ? "price unknown" : `$${t.usd.toFixed(2)}`;
  return `${k(t.cacheHit + t.cacheMiss)} in (${k(t.cacheHit)} cached), ${k(t.output)} out (${k(t.reasoning)} reasoning), ${usd}`;
}

// "How much have you spent?" in my chat: the same numbers as Settings.
// report: async () => the same object Settings gets (summary, balance, runway).
function createSpendingToolSource(report) {
  const name = "api_spending__summary";
  return {
    listToolSchemas: () => [
      {
        type: "function",
        function: {
          name,
          description:
            "Read what your API use has cost (DeepSeek and any other remote model): all-time, today and this month, in dollars and tokens (input from cache, input not from cache, output, reasoning), split by model and by use (self-work, chat, bench). It also has the DeepSeek balance and how long it lasts, this month's projection, last month, what peak hours added, the cache hit rate, and what each issue cost with its outcome. Use it when the user asks what you've spent; quote the numbers, don't estimate.",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    isKnownToolName: (candidate) => candidate === name,
    executeTool: async (candidate) => {
      if (candidate !== name) throw new Error("Unknown spending tool");
      return JSON.stringify(await report());
    },
  };
}

module.exports = { createApiSpending, createBalanceReader, runway, createSpendingToolSource, isPeak, nextOffPeak, tokensOf, costOf, costParts, describeUsage, PRICES, USES };
