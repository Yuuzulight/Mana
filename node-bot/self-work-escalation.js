// #1406: when her local attempts at an issue all fail, she escalates to
// DeepSeek, one tier at a time, each running her own self-work loop. This
// decides whether a tier may run now: switched on with a key, local-only
// off, one run per tier per issue (my "retry" resets it), 5 remote runs a
// day, and DeepSeek's peak hours held for half price. "Go ahead" from me
// lets one run past the hold or a cap. Kept across restarts.
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
const MAX_RUNS_KEPT = 500;
const MAX_FACTS = 4000;

// settings: () => { enabled, baseUrl, apiKey } (the protected store).
function createEscalation({ file, settings, env = process.env, now = () => new Date(), tiers = TIERS, perDay = PER_DAY }) {
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
    if (!s.apiKey) return "there's no DeepSeek key in Settings";
    return null;
  }

  // The tiers this issue hasn't used since my last "retry".
  const tiersLeft = (issue) => tiers.filter((t) => !data.runs.some((r) => r.issue === key(issue) && r.tier === t.id && !r.reset));

  // May the next tier run now? { ok } or { ok: false, why, kind: "peak" | "day" }.
  function gate(issue) {
    if (data.goAhead[key(issue)]) return { ok: true };
    const ranToday = data.runs.filter((r) => r.at.startsWith(today())).length;
    if (ranToday >= perDay) {
      return { ok: false, kind: "day", why: `I've used today's ${perDay} DeepSeek runs. Say "go ahead on #${issue}" to let one more through, or I'll try tomorrow.` };
    }
    if (isPeak(now())) {
      const at = nextOffPeak(now());
      const local = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      return { ok: false, kind: "peak", why: `DeepSeek is at peak price now; it's half price from ${local}, so I'll wait for that. Say "go ahead on #${issue}" to run it now.` };
    }
    return { ok: true };
  }

  // A tier starts: it counts, and a "go ahead" is used up.
  function begin(issue, tier) {
    data.runs.push({ at: now().toISOString(), issue: key(issue), tier: tier.id });
    delete data.goAhead[key(issue)];
    save();
  }

  // Held for later (peak, the day's cap), with what her attempts found, so
  // the next run on it goes straight to the escalation.
  function hold(issue, facts, why) {
    data.held[key(issue)] = { at: now().toISOString(), facts: String(facts || "").slice(0, MAX_FACTS), why };
    save();
  }
  const held = (issue) => data.held[key(issue)] || null;
  function release(issue) {
    if (!data.held[key(issue)]) return;
    delete data.held[key(issue)];
    save();
  }

  // Held and still not allowed: the idle picker leaves it until it is.
  const waitingNow = (issue) => Boolean(held(issue)) && !gate(issue).ok;

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

  return { unavailable, tiersLeft, gate, begin, hold, held, release, waitingNow, goAhead, reset, config, tiers };
}

module.exports = { createEscalation, TIERS, PER_DAY };
