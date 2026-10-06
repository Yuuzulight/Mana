// #1406: what Mana's API use costs. One bucket per day, model and use
// (self-work, chat, bench) with its tokens (input from cache, input not
// from cache, output, and the reasoning part of output) and dollars. Kept
// in her data folder across restarts; never a prompt, code or key.
const fs = require("fs");
const path = require("path");

// Dollars per 1M tokens, off-peak; peak is double. From DeepSeek's pricing
// page (2026-10). A model not listed shows tokens only.
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
// part of output, so it isn't charged twice.
function costOf(model, tokens, peak) {
  const p = PRICES[model];
  if (!p) return null;
  const m = peak ? 2 : 1;
  return ((tokens.cacheHit * p.hit + tokens.cacheMiss * p.miss + tokens.output * p.out) * m) / 1e6;
}

function emptyTotals() {
  return { requests: 0, usd: 0, unpricedRequests: 0, ...Object.fromEntries(KINDS.map((k) => [k, 0])) };
}

function add(into, b) {
  into.requests += b.requests;
  into.usd += b.usd;
  into.unpricedRequests += b.unpricedRequests;
  for (const k of KINDS) into[k] += b[k];
}

function createApiSpending({ file, now = () => new Date() }) {
  let data = { version: 1, buckets: {} };
  try {
    if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // A broken file starts fresh rather than stopping her.
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
    fs.renameSync(`${file}.tmp`, file);
  }

  // One API response's usage. Returns what it cost, for the run's own line.
  function record({ model, use, usage, at = now() }) {
    if (!USES.includes(use)) throw new Error(`unknown API use: ${use}`);
    const tokens = tokensOf(usage);
    const peak = isPeak(at);
    const usd = costOf(model, tokens, peak);
    const key = `${at.toISOString().slice(0, 10)}|${model}|${use}`;
    const b = (data.buckets[key] ||= emptyTotals());
    add(b, { requests: 1, usd: usd ?? 0, unpricedRequests: usd === null ? 1 : 0, ...tokens });
    if (peak) b.peakRequests = (b.peakRequests || 0) + 1;
    save();
    return { ...tokens, usd, peak };
  }

  // All-time, today and this month (UTC days), each split by model and use.
  function summary() {
    const today = now().toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    const periods = { total: () => true, today: (d) => d === today, month: (d) => d.startsWith(month) };
    const out = {};
    for (const [name, inPeriod] of Object.entries(periods)) {
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
      out[name] = { ...all, byModel, byUse };
    }
    return { ...out, peakNow: isPeak(now()), prices: PRICES };
  }

  return { record, summary };
}

// "412k in (380k cached), 31k out (12k reasoning), $0.04"
function describeUsage(t) {
  const k = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const usd = t.usd === null || t.usd === undefined ? "price unknown" : `$${t.usd.toFixed(2)}`;
  return `${k(t.cacheHit + t.cacheMiss)} in (${k(t.cacheHit)} cached), ${k(t.output)} out (${k(t.reasoning)} reasoning), ${usd}`;
}

// "How much have you spent?" in my chat: the same numbers as Settings.
function createSpendingToolSource(spending) {
  const name = "api_spending__summary";
  return {
    listToolSchemas: () => [
      {
        type: "function",
        function: {
          name,
          description:
            "Read what your API use has cost (DeepSeek and any other remote model): all-time, today and this month, in dollars and tokens (input from cache, input not from cache, output, reasoning), split by model and by use (self-work, chat, bench). Use it when the user asks what you've spent; quote the numbers, don't estimate.",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    isKnownToolName: (candidate) => candidate === name,
    executeTool: async (candidate) => {
      if (candidate !== name) throw new Error("Unknown spending tool");
      return JSON.stringify(spending.summary());
    },
  };
}

module.exports = { createApiSpending, createSpendingToolSource, isPeak, nextOffPeak, tokensOf, costOf, describeUsage, PRICES, USES };
