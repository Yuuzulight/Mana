// #1406: when her local attempts at an issue all fail, she escalates to a
// provider's models, one tier at a time, each running her own self-work
// loop. This decides whether a tier may run now: switched on with a key,
// local-only off, one run per tier per issue (my "retry" resets it), 5
// remote runs a day, and DeepSeek's peak hours held for half price. "Go
// ahead" from me lets one run past the hold or a cap. Kept across restarts.
// #1441: the tiers are the models I pick in Settings (first tier, then an
// optional second); DeepSeek's Flash then Pro until I do.
const fs = require("fs");
const path = require("path");
const { isLocalOnly } = require("./local-only");
const { isPeak, nextOffPeak } = require("./api-spending");

// ponytail: provisional; #1411's bench sets the order and thinking.
const TIERS = [
  { id: "flash", label: "DeepSeek Flash", model: "deepseek-flash", thinking: true },
  { id: "pro", label: "DeepSeek Pro", model: "deepseek-v4-pro", thinking: true },
];
const PER_DAY = 5;
// #1406: how long Claude's usage limit holds an issue (Pro's five-hour window).
const LIMIT_HOLD_MS = 5 * 60 * 60 * 1000;

// The tiers for these settings: the models picked, or DeepSeek's Flash (the
// 2026-10-16 bench: Pro solved one more case for five times the cost). Only
// DeepSeek gets its thinking switch (null: the request leaves it out).
// #1406: Claude Code (her own Claude subscription, ai/claude-code-runner.js)
// comes last when MANA_CLAUDE_CODE=1: an agent, not a model her loop calls.
function tiersFor(s, env = {}) {
  const deepseek = (s.preset || "deepseek") === "deepseek"; // settings from before providers
  const models = s.models?.length ? s.models : deepseek ? [TIERS[0].model] : [];
  const tiers = models.map((model) => {
    const builtIn = deepseek && TIERS.find((t) => t.model === model);
    return builtIn ? { ...builtIn } : { id: model, label: model, model, thinking: deepseek ? true : null };
  });
  if (env.MANA_CLAUDE_CODE === "1") {
    const model = env.MANA_CLAUDE_CODE_MODEL || "sonnet";
    tiers.push({ id: "claude", label: `Claude Code (${model})`, model, thinking: null, agent: true });
  }
  return tiers;
}
const MAX_RUNS_KEPT = 500;
const MAX_FACTS = 4000;

// settings: () => { enabled, preset, label, needsKey, models, baseUrl, apiKey }
// (the protected store). tiers: fixed tiers instead (tests).
function createEscalation({ file, settings, env = process.env, now = () => new Date(), tiers = null, perDay = PER_DAY }) {
  const currentTiers = () => tiers || tiersFor(settings(), env);
  let data = { runs: [], goAhead: {}, held: {} };
  try {
    if (fs.existsSync(file)) data = { ...data, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    // A broken file starts fresh rather than stopping her.
  }
  const save = () => {
    data.runs = data.runs.slice(-MAX_RUNS_KEPT);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  };
  const key = (issue) => String(issue);
  const today = () => now().toISOString().slice(0, 10);

  // Why it can't be used at all, or null.
  function unavailable() {
    const s = settings();
    if (isLocalOnly(env)) return "local-only mode is on";
    if (!s.enabled) return "it's switched off in Settings";
    if (!s.apiKey && s.needsKey !== false) return `there's no ${s.label || "DeepSeek"} key in Settings`;
    if (!currentTiers().length) return `no ${s.label ? `${s.label} ` : ""}model is picked for it in Settings`;
    return null;
  }

  // The tiers this issue hasn't used since my last "retry".
  const tiersLeft = (issue) => currentTiers().filter((t) => !data.runs.some((r) => r.issue === key(issue) && r.tier === t.id && !r.reset));

  // May the next tier run now? { ok } or { ok: false, why, kind: "limit" | "peak" | "day" }.
  // #1406: Claude's usage limit holds it until the window resets, go ahead or
  // not; DeepSeek's price hours don't apply to her Claude subscription.
  function gate(issue, tier = null) {
    const until = data.held[key(issue)]?.until;
    if (until && now() < new Date(until)) return { ok: false, kind: "limit", why: `Claude's usage limit is reached; I'll pick #${issue} up after it resets.` };
    if (data.goAhead[key(issue)]) return { ok: true };
    const ranToday = data.runs.filter((r) => r.at.startsWith(today())).length;
    if (ranToday >= perDay) {
      return { ok: false, kind: "day", why: `I've used today's ${perDay} escalation runs. Say "go ahead on #${issue}" to let one more through, or I'll try tomorrow.` };
    }
    if (!tier?.agent && (settings().preset || "deepseek") === "deepseek" && isPeak(now())) {
      const at = nextOffPeak(now());
      const local = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      return { ok: false, kind: "peak", why: `DeepSeek is at peak price now; it's half price from ${local}, so I'll wait for that. Say "go ahead on #${issue}" to run it now.` };
    }
    return { ok: true };
  }

  // A tier starts: it counts, and a "go ahead" is used up.
  function begin(issue, tier) {
    data.runs.push({ at: now().toISOString(), issue: key(issue), tier: tier.id, model: tier.model });
    delete data.goAhead[key(issue)];
    save();
  }

  // #1441: how a tier's run went, for Settings' per-model numbers.
  function finish(issue, tier, { passed, usd = null } = {}) {
    const run = data.runs.findLast((r) => r.issue === key(issue) && r.tier === tier.id && r.passed === undefined);
    if (!run) return;
    Object.assign(run, { passed: passed === true, usd });
    save();
  }

  // Per model: runs with an outcome, how many passed, and what they cost
  // (null when a run's price wasn't known).
  function stats() {
    const by = {};
    for (const r of data.runs) {
      if (r.passed === undefined) continue;
      const s = (by[r.model || r.tier] ||= { model: r.model || r.tier, runs: 0, passed: 0, usd: 0 });
      s.runs += 1;
      s.passed += r.passed ? 1 : 0;
      s.usd = s.usd === null || r.usd === null || r.usd === undefined ? null : s.usd + r.usd;
    }
    return Object.values(by);
  }

  // Held for later (peak, the day's cap), with what her attempts found, so
  // the next run on it goes straight to the escalation.
  function hold(issue, facts, why, until = null) {
    data.held[key(issue)] = { at: now().toISOString(), facts: String(facts || "").slice(0, MAX_FACTS), why, ...(until ? { until: until.toISOString() } : {}) };
    save();
  }

  // #1406: Claude's usage limit: the run didn't happen (the tier stays left)
  // and the issue waits about one five-hour window.
  function pause(issue, tier, facts) {
    cancel(issue, tier);
    hold(issue, facts, "claude-limit", new Date(now().getTime() + LIMIT_HOLD_MS));
  }

  // A run that didn't happen: the tier stays left for this issue.
  function cancel(issue, tier) {
    const i = data.runs.findLastIndex((r) => r.issue === key(issue) && r.tier === tier.id && r.passed === undefined);
    if (i < 0) return;
    data.runs.splice(i, 1);
    save();
  }
  const held = (issue) => data.held[key(issue)] || null;
  function release(issue) {
    if (!data.held[key(issue)]) return;
    delete data.held[key(issue)];
    save();
  }

  // Held and still not allowed: the idle picker leaves it until it is.
  const waitingNow = (issue) => Boolean(held(issue)) && !gate(issue, tiersLeft(issue)[0]).ok;

  // "Go ahead": one run past the peak hold or a cap.
  function goAhead(issue) {
    data.goAhead[key(issue)] = now().toISOString();
    save();
  }

  // My "retry": this issue's tiers can run again.
  function reset(issue) {
    for (const r of data.runs) if (r.issue === key(issue)) r.reset = true;
    release(issue);
    save();
  }

  const config = () => {
    const { baseUrl, apiKey } = settings();
    return { baseUrl, apiKey };
  };

  return { unavailable, tiersLeft, gate, begin, finish, cancel, pause, stats, hold, held, release, waitingNow, goAhead, reset, config, get tiers() { return currentTiers(); } };
}

module.exports = { createEscalation, tiersFor, TIERS, PER_DAY };
