// #1382: one local view of what Mana already measures -- tool calls (the
// #188 audit log), benchmark and behaviour-eval reports (#1221, #1381) and
// this process's operation timings -- keyed by tool, model and config, with
// sample counts and 95% intervals. Nothing here changes a setting: route
// recommendations are advice for her planner (#1383) and resource
// decisions (#1380), never a model switch, a cloud call or a looser approval.
const fs = require("fs");
const path = require("path");

const VERSION = 1;
const DEFAULTS = { maxAgeDays: 30, staleDays: 7, maxToolEntries: 5000, maxReports: 50, minRuns: 10 };
const DAY_MS = 24 * 60 * 60 * 1000;

// 95% Wilson interval for k of n.
function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

function percentile(sorted, q) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;
}

const OUTCOMES = ["succeeded", "returned", "task-failed", "denied", "pending", "threw"];

// toolCalls: tool-call log entries. reports: { kind, model, context, at,
// runs, passes } from bench/eval reports. operations: perfMetrics.operations.
function buildTelemetry({ toolCalls = [], reports = [], operations = {}, now = Date.now(), ...opts } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const since = now - o.maxAgeDays * DAY_MS;
  const staleBefore = now - o.staleDays * DAY_MS;
  const missing = ["user corrections: nothing records them yet"];

  const groups = new Map();
  let unrecordedOutcome = 0;
  for (const e of toolCalls) {
    const at = Date.parse(e.at);
    if (!e.name || !(at >= since)) continue;
    const key = `${e.name}\u0000${e.model || ""}`;
    if (!groups.has(key)) groups.set(key, { tool: e.name, model: e.model || null, entries: [] });
    groups.get(key).entries.push({ ...e, at });
  }
  const tools = [...groups.values()].map(({ tool, model, entries }) => {
    const outcomes = Object.fromEntries(OUTCOMES.map((k) => [k, 0]));
    let unrecorded = 0;
    for (const e of entries) {
      const outcome = e.outcome || (e.ok === false ? "threw" : null);
      if (outcome in outcomes) outcomes[outcome] += 1;
      else unrecorded += 1;
    }
    unrecordedOutcome += unrecorded;
    const recorded = entries.length - unrecorded;
    // Transport: the call came back at all. Task: what came back said it failed.
    const failed = outcomes.threw + outcomes["task-failed"];
    const ms = entries.map((e) => e.durationMs).filter(Number.isFinite).sort((a, b) => a - b);
    const lastAt = Math.max(...entries.map((e) => e.at));
    return {
      tool,
      model,
      samples: entries.length,
      outcomes,
      outcomeUnrecorded: unrecorded,
      transportFailures: outcomes.threw,
      taskFailureRate: recorded ? failed / recorded : null,
      taskFailureInterval: wilson(failed, recorded),
      p50Ms: percentile(ms, 0.5),
      p95Ms: percentile(ms, 0.95),
      lastAt: new Date(lastAt).toISOString(),
      stale: lastAt < staleBefore,
    };
  });
  tools.sort((a, b) => b.samples - a.samples);
  if (unrecordedOutcome) missing.push(`task outcome: ${unrecordedOutcome} older tool calls were logged before outcomes were recorded`);
  if (!tools.length) missing.push(`tool calls: none in the last ${o.maxAgeDays} days`);

  // Reports: newest per kind, model and context; a config change is its own row.
  const latest = new Map();
  for (const r of reports) {
    const at = Date.parse(r.at);
    if (!(at >= since) || !r.model || !(r.runs > 0)) continue;
    const key = `${r.kind}\u0000${r.model}\u0000${r.context || ""}`;
    if (!latest.has(key) || Date.parse(latest.get(key).at) < at) latest.set(key, r);
  }
  const models = [...latest.values()].map((r) => ({
    kind: r.kind,
    model: r.model,
    context: r.context || null,
    runs: r.runs,
    passRate: r.passes / r.runs,
    interval: wilson(r.passes, r.runs),
    at: r.at,
    stale: Date.parse(r.at) < staleBefore,
    source: r.source || null,
  }));
  if (!models.length) missing.push(`benchmarks: no report in the last ${o.maxAgeDays} days`);

  return {
    version: VERSION,
    generatedAt: new Date(now).toISOString(),
    window: { maxAgeDays: o.maxAgeDays, staleDays: o.staleDays },
    tools,
    models,
    // This process only, since it started; not kept across restarts.
    operations: Object.entries(operations).map(([label, v]) => ({ label, count: v.count, avgMs: v.avgMs, maxMs: v.maxMs })),
    missing,
  };
}

// Advice only. candidates: [{ model, local }]. A non-local candidate is
// eligible only when local-only is off and it's in approvedFallbacks.
// Recommends switching only when the other model's whole interval beats
// the current one's estimate on fresh data with enough runs.
function recommendRoute(telemetry, { kind, current, candidates = [], localOnly = false, approvedFallbacks = [], minRuns = DEFAULTS.minRuns }) {
  const eligible = candidates.filter((c) => c.local || (!localOnly && approvedFallbacks.includes(c.model)));
  const evidence = eligible.map((c) => {
    const m = telemetry.models.find((x) => x.kind === kind && x.model === c.model && !x.stale);
    return m ? { model: c.model, runs: m.runs, passRate: m.passRate, interval: m.interval } : { model: c.model, runs: 0, passRate: null, interval: null };
  });
  const mine = evidence.find((e) => e.model === current);
  const keep = (reason) => ({ kind, recommend: null, keep: current, reason, evidence });
  if (!mine || mine.runs < minRuns) return keep(`not enough fresh ${kind} runs for ${current} (${mine?.runs || 0}, need ${minRuns})`);
  const better = evidence
    .filter((e) => e.model !== current && e.runs >= minRuns && e.interval[0] > mine.passRate)
    .sort((a, b) => b.interval[0] - a.interval[0])[0];
  if (!better) return keep(`no eligible model is clearly better than ${current} at ${kind}`);
  return {
    kind,
    recommend: better.model,
    keep: null,
    reason: `${better.model} passed ${Math.round(better.passRate * 100)}% of ${better.runs} ${kind} runs (95% interval from ${Math.round(better.interval[0] * 100)}%), above ${current}'s ${Math.round(mine.passRate * 100)}% of ${mine.runs}`,
    evidence,
  };
}

// Short lines for her planner's prompt.
function plannerSummary(telemetry, maxTools = 8) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  const lines = telemetry.tools.slice(0, maxTools).map((t) => {
    const fail = t.taskFailureRate == null ? "failure rate not measured" : `${pct(t.taskFailureRate)} failed (${pct(t.taskFailureInterval[0])}-${pct(t.taskFailureInterval[1])})`;
    return `${t.tool}${t.model ? ` (${t.model})` : ""}: ${t.samples} calls, ${fail}, typical ${t.p50Ms ?? "?"} ms${t.stale ? ", stale" : ""}`;
  });
  for (const m of telemetry.models) lines.push(`${m.kind} ${m.model}${m.context ? ` @${m.context}` : ""}: ${pct(m.passRate)} of ${m.runs} runs${m.stale ? ", stale" : ""}`);
  for (const gap of telemetry.missing) lines.push(`Not measured: ${gap}`);
  return lines.join("\n");
}

// A report.json from the self-work bench or the behaviour evals, as a row.
function reportRow(json, at, source) {
  const runs = json.summary?.runs ?? json.total ?? json.results?.length;
  const passes = json.passed ?? json.results?.filter((r) => r.passed).length;
  if (!json.model || !(runs > 0) || !Number.isFinite(passes)) return null;
  return { kind: json.gate ? "behavior" : "coding", model: json.model, context: json.context || null, at, runs, passes, source };
}

// Reads the newest maxReports reports under resultsDir.
function loadReports(resultsDir, maxReports = DEFAULTS.maxReports) {
  if (!fs.existsSync(resultsDir)) return [];
  return fs
    .readdirSync(resultsDir)
    .map((d) => path.join(resultsDir, d, "report.json"))
    .filter((f) => fs.existsSync(f))
    .map((f) => ({ f, mtime: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, maxReports)
    .map(({ f, mtime }) => {
      try {
        return reportRow(JSON.parse(fs.readFileSync(f, "utf8")), new Date(mtime).toISOString(), path.basename(path.dirname(f)));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

module.exports = { VERSION, buildTelemetry, recommendRoute, plannerSummary, reportRow, loadReports, wilson };
