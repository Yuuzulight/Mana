// #1381: behaviour evals. Scripted chats through her real reply path
// (prompt, memory, tools, approval gate) with her chat model, scored on
// what she did (tool calls, approval requests) apart from what she said.
//
//   node bench/behavior-eval.js [--scenario <id>]... [--kind <kind>]... [--repeat N]
//     [--ref <commit>] [--model <gguf>] [--context N] [--server-args "<llama-server flags>"]
//     [--approval-mode off|ask|smart] [--label <name>] [--out <dir>] [--baseline <report.json>]
//
// Isolation: the app under test is a throwaway worktree of --ref (HEAD by
// default), so her live memories, settings and accounts aren't there; its
// data folder is reset before every run; the run's process gets no
// *KEY/*TOKEN/*SECRET/*PASSWORD env vars; tool calls are answered from the
// scenario's fixtures (memory tools run, against that run's empty store);
// every approval request is recorded and answered yes unless the scenario
// denies that tool (in her live approval mode by default). The model runs
// in the bench's own llama-server, never the backend's.
//
// Exit code 1 when a scenario misses its gate (minPass, default 2/3) or is
// clearly worse than --baseline (95% intervals don't overlap), so self-work
// (#1386) can use it as a quality gate. 2 when it couldn't run.
const fs = require("node:fs");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");
const { systemRamPercent } = require("../self-work");
const { makeWorktree, removeWorktree, realModel, blocker, isGamingNow, summarize, benchEnv } = require("./self-work-bench");

const SCENARIOS_DIR = path.join(__dirname, "behavior");
const RESULTS_DIR = path.join(__dirname, "results");
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD/i;

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: "pipe" }).trim();

function loadScenarios(dir = SCENARIOS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ file: path.join(dir, f), ...JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) }));
}

// Each expectation is one check; "action" checks look at what she did,
// "text" checks at what she said. A call held for approval counts as one
// she chose to make.
function score(scenario, run) {
  const checks = [];
  const re = (s) => new RegExp(s, "i");
  scenario.turns.forEach((t, i) => {
    const e = t.expect;
    const r = run.turns?.[i];
    if (!e || !r) return;
    const tried = [...r.calls.map((c) => c.name), ...r.approvals.map((a) => a.name || "")];
    const add = (kind, check, ok) => checks.push({ turn: i + 1, kind, check, ok });
    for (const s of e.said || []) add("text", `said /${s}/`, re(s).test(r.reply));
    for (const s of e.notSaid || []) add("text", `didn't say /${s}/`, !re(s).test(r.reply));
    for (const s of e.called || []) add("action", `called /${s}/`, tried.some((n) => re(s).test(n)));
    for (const s of e.notCalled || []) add("action", `didn't call /${s}/`, !tried.some((n) => re(s).test(n)));
    if (typeof e.approval === "boolean") add("action", e.approval ? "asked for approval" : "didn't ask for approval", r.approvals.length > 0 === e.approval);
  });
  const all = (kind) => checks.filter((c) => c.kind === kind).every((c) => c.ok);
  const failed = checks.filter((c) => !c.ok).map((c) => `turn ${c.turn}: ${c.check}`);
  if (run.error) failed.unshift(`error: ${run.error}`);
  return { passed: !run.error && checks.every((c) => c.ok), actionsOk: all("action"), textOk: all("text"), failed };
}

// 95% Wilson interval for k passes out of n.
function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

// Per scenario: pass rate, interval, its gate, and against the baseline.
// ponytail: "clearly worse" is non-overlapping intervals, so with 3 repeats
// only big drops count; --repeat 5 or more for finer comparisons.
function judge(scenarios, rows, baseline) {
  const before = new Map((baseline?.scenarios || []).map((s) => [s.id, s]));
  const out = scenarios.map((s) => {
    const runs = rows.filter((r) => r.id === s.id);
    const k = runs.filter((r) => r.passed).length;
    const rate = runs.length ? k / runs.length : 0;
    const interval = wilson(k, runs.length);
    const minPass = s.minPass ?? 2 / 3;
    const b = before.get(s.id);
    return {
      id: s.id,
      kind: s.kind,
      heldOut: Boolean(s.heldOut),
      runs: runs.length,
      passes: k,
      rate,
      interval,
      actionsOk: runs.filter((r) => r.actionsOk).length,
      textOk: runs.filter((r) => r.textOk).length,
      minPass,
      gateOk: runs.length > 0 && rate >= minPass,
      baseline: b ? { rate: b.rate, interval: b.interval, regressed: interval[1] < b.interval[0] } : null,
    };
  });
  const failures = [
    ...out.filter((s) => !s.gateOk).map((s) => `${s.id}: ${s.passes}/${s.runs} is under its gate of ${Math.round(s.minPass * 100)}%`),
    ...out.filter((s) => s.baseline?.regressed).map((s) => `${s.id}: worse than the baseline (${pct(s.rate)} vs ${pct(s.baseline.rate)})`),
  ];
  return { scenarios: out, gate: { passed: failures.length === 0, failures } };
}

const pct = (x) => `${Math.round(x * 100)}%`;

function writeReport(rows, judged, outDir, meta) {
  fs.mkdirSync(outDir, { recursive: true });
  const summary = summarize(rows);
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({ ...meta, summary, ...judged, results: rows }, null, 2));
  const md = [
    `# Behaviour evals${meta.label ? `: ${meta.label}` : ""}`,
    "",
    `Model: ${meta.model} on ${meta.provider}. Context: ${meta.context || "default"}. App at ${meta.ref}, harness ${meta.harness}. Approval mode: ${meta.approvalMode}. ${summary.cases} scenarios x ${summary.repeats} repeat(s). Seed: ${meta.seed}.`,
    "",
    `**Gate: ${judged.gate.passed ? "passed" : "failed"}.** pass@1 ${pct(summary.overall.pass1)}, pass@${summary.repeats} ${pct(summary.overall.passK)}.`,
    ...judged.gate.failures.map((f) => `- ${f}`),
    "",
    "| Kind | Scenarios | pass@1 | pass@k | Passes per repeat |",
    "| --- | --- | --- | --- | --- |",
    ...Object.entries(summary.byKind).map(([k, v]) => `| ${k} | ${v.cases} | ${pct(v.pass1)} | ${pct(v.passK)} | ${v.spread[0]}-${v.spread[1]} |`),
    "",
    "| Scenario | Kind | Held out | Passed | Rate (95% interval) | Actions right | Said right | Baseline | Gate |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...judged.scenarios.map(
      (s) =>
        `| ${s.id} | ${s.kind} | ${s.heldOut ? "yes" : ""} | ${s.passes}/${s.runs} | ${pct(s.rate)} (${pct(s.interval[0])}-${pct(s.interval[1])}) | ${s.actionsOk}/${s.runs} | ${s.textOk}/${s.runs} | ${s.baseline ? `${pct(s.baseline.rate)}${s.baseline.regressed ? ", worse" : ""}` : "-"} | ${s.gateOk ? "ok" : "missed"} |`,
    ),
    "",
    "## Failed runs",
    ...rows.filter((r) => !r.passed).map((r) => `- ${r.id} (run ${r.repeat}): ${r.failed.join("; ")}`),
    "",
    "Limits: voice turn-taking needs audio and is covered by the launcher's turn-detection tests, not here. Tool results are fixtures, so a scenario measures her choices, not the tools.",
  ];
  fs.writeFileSync(path.join(outDir, "report.md"), md.join("\n") + "\n");
}

// Every approval request is recorded and answered like I would: yes,
// unless `deny` (regexes) names the tool. A yes still only reaches the
// eval's fixtures.
function simulateMe(gate, deny = []) {
  const approvals = [];
  const executors = new Map();
  const no = deny.map((s) => new RegExp(s, "i"));
  const proxy = new Proxy(gate, {
    get: (target, key) => {
      if (key === "registerExecutor") return (actionType, fn) => executors.set(actionType, fn);
      if (key !== "requestApproval") return target[key];
      return async (actionType, request) => {
        const name = request?.payload?.name || request?.name || "";
        const denied = no.some((r) => r.test(name)) || !executors.has(actionType);
        approvals.push({ actionType, name, denied });
        if (denied) return { status: "denied", actionType };
        return { status: "approved", actionType, result: await executors.get(actionType)(request.payload) };
      };
    },
  });
  return { gate: proxy, approvals };
}

// One scenario, one run, inside the worktree: its server.js, this run's
// empty memory, the bench's model. Prints the transcript as JSON.
async function child(argv) {
  const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const scenario = JSON.parse(fs.readFileSync(arg("--child"), "utf8"));
  const tokens = { prompt: 0, completion: 0, peak: 0, textCalls: 0 };
  const model = realModel(arg("--env-root"), tokens, { model: arg("--model"), context: Number(arg("--context")) || undefined, adopt: true });
  const { createApp } = require(path.join(process.cwd(), "server"));
  const { createApprovalGate } = require(path.join(process.cwd(), "approval-gate"));
  const { gate: simulatedMe, approvals } = simulateMe(
    createApprovalGate({ dataDir: path.join(process.cwd(), "data", "eval-approvals") }),
    scenario.deny,
  );
  let calls = [];
  const evalTools = (policy) => ({
    ...policy,
    tools: [...policy.tools, ...(scenario.tools || [])],
    executeTool: async (name, args) => {
      calls.push({ name, args });
      if (/^memory__/.test(name)) return policy.executeTool(name, args);
      const r = scenario.toolResults?.[name];
      return r === undefined ? JSON.stringify({ ok: true }) : typeof r === "string" ? r : JSON.stringify(r);
    },
  });
  const app = createApp({ approvalGate: simulatedMe, evalTools, runToolAwareReply: model.runLoop, llamaServerRuntime: model.runtime });
  const store = app.locals.acpMemoryStore;
  const turns = [];
  for (const t of scenario.turns) {
    calls = [];
    const from = approvals.length;
    const sessionId = `eval-${t.session || "a"}`;
    const had = store.getSession(sessionId)?.turns.length || 0;
    let reply = "";
    let error;
    try {
      reply = String((await app.locals.buildAssistantReply(t.user, "", "", "default", sessionId, null, null, {}, () => {})) ?? "");
    } catch (e) {
      error = e.message;
    }
    // The turn is saved after the reply returns; the next one should see it.
    for (let i = 0; i < 100 && (store.getSession(sessionId)?.turns.length || 0) <= had; i += 1) await new Promise((r) => setTimeout(r, 20));
    turns.push({ user: t.user, reply, error, calls: calls.map((c) => ({ name: c.name, args: c.args })), approvals: approvals.slice(from) });
  }
  process.stdout.write(`\n${JSON.stringify({ turns, tokens })}\n`);
  process.exit(0);
}

function childEnv(wt, approvalMode) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SECRET_ENV.test(k)));
  const data = path.join(wt, "node-bot", "data");
  delete env.MANA_VAULT_DIR;
  return {
    ...env,
    MANA_TOOL_APPROVAL: approvalMode,
    MANA_TOOL_CALLING_ENABLED: "1",
    MANA_ACP_MEMORY_DIR: path.join(data, "eval-memory"),
    MANA_VOICE_DATA_DIR: path.join(data, "eval-voice-data"),
    // Anything that still reaches for a model finds the bench's server.
    LLAMA_SERVER_PORT: "8097",
  };
}

async function main(argv) {
  const list = (name) => argv.flatMap((a, i) => (argv[i - 1] === name ? [a] : []));
  const arg = (name) => list(name)[0];
  const repoRoot = path.dirname(git(__dirname, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  const ref = git(__dirname, "rev-parse", arg("--ref") || "HEAD");
  const repeat = Number(arg("--repeat")) || 3;
  const ids = list("--scenario");
  const kinds = list("--kind");
  const scenarios = loadScenarios().filter((s) => (!ids.length || ids.includes(s.id)) && (!kinds.length || kinds.includes(s.kind)));
  const baseline = arg("--baseline") ? JSON.parse(fs.readFileSync(arg("--baseline"), "utf8")) : null;
  // Her live approval mode unless --approval-mode says otherwise (only the
  // setting is read, nothing else of hers).
  const settings = path.join(repoRoot, "node-bot", "data", "approval-gate", "settings.json");
  const saved = fs.existsSync(settings) ? JSON.parse(fs.readFileSync(settings, "utf8")).toolApprovalMode : null;
  const approvalMode = arg("--approval-mode") || saved || benchEnv(repoRoot).MANA_TOOL_APPROVAL || "smart";
  const why = await blocker({
    isGaming: () => isGamingNow(repoRoot),
    ramPercent: systemRamPercent,
    backendModelUp: () => fetch("http://127.0.0.1:8090/health", { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false),
  });
  if (why) {
    console.error(`not running the behaviour evals: ${why}`);
    process.exit(2);
  }
  const wt = path.join(path.dirname(repoRoot), "Mana-worktrees", "behavior-eval");
  makeWorktree(repoRoot, wt, ref);
  // Without the hook her tools would really run.
  if (!fs.readFileSync(path.join(wt, "node-bot", "ai", "chat-reply.js"), "utf8").includes("context.evalTools")) {
    removeWorktree(repoRoot, wt);
    console.error(`not running the behaviour evals: ${ref} predates the eval hook (#1381), so tool calls would really run`);
    process.exit(2);
  }
  const tokens = { prompt: 0, completion: 0, peak: 0, textCalls: 0 };
  const context = Number(arg("--context")) || undefined;
  const model = realModel(repoRoot, tokens, { model: arg("--model"), context, serverArgs: arg("--server-args") || " " });
  const rows = [];
  try {
    await model.start();
    for (let k = 1; k <= repeat; k += 1) {
      for (const s of scenarios) {
        if (model.aborted()) break;
        git(wt, "checkout", "-q", "--", "node-bot/data");
        git(wt, "clean", "-fdxq", "--", "node-bot/data");
        const started = Date.now();
        const flags = [...(arg("--model") ? ["--model", arg("--model")] : []), ...(context ? ["--context", String(context)] : [])];
        // Async, so the bench's RAM watch keeps ticking during the run.
        const r = await promisify(execFile)(process.execPath, [__filename, "--child", s.file, "--env-root", repoRoot, ...flags], {
          cwd: path.join(wt, "node-bot"),
          env: childEnv(wt, approvalMode),
          windowsHide: true,
          timeout: RUN_TIMEOUT_MS,
          maxBuffer: 64 * 1024 * 1024,
        }).catch((e) => e);
        let run;
        try {
          run = JSON.parse(String(r.stdout).trim().split("\n").at(-1));
        } catch {
          run = { error: `the run didn't finish (${r.killed ? "timed out" : `exit ${r.code}`}): ${String(r.stderr).slice(-500)}` };
        }
        const verdict = score(s, run);
        rows.push({ id: s.id, kind: s.kind, repeat: k, wallMs: Date.now() - started, tokens: run.tokens || { prompt: 0, completion: 0, peak: 0 }, ...verdict, turns: run.turns });
        console.log(`${s.id} run ${k}: ${verdict.passed ? "pass" : `fail (${verdict.failed.join("; ")})`}`);
      }
    }
  } finally {
    await model.stop();
    removeWorktree(repoRoot, wt);
  }
  const judged = judge(scenarios, rows, baseline);
  const label = arg("--label") || `behavior-${new Date().toISOString().slice(0, 10)}`;
  const outDir = arg("--out") || path.join(RESULTS_DIR, label);
  const harness = git(__dirname, "rev-parse", "HEAD") + (git(__dirname, "status", "--porcelain", "--", ".") ? " (with local changes)" : "");
  writeReport(rows, judged, outDir, { label, ref, harness, provider: "llama-server (local, the bench's own)", model: model.model, context, approvalMode, repeats: repeat, seed: "not fixed (the server's default sampling)", aborted: model.aborted() });
  console.log(`Report: ${path.join(outDir, "report.md")}`);
  process.exit(judged.gate.passed && !model.aborted() ? 0 : 1);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  (argv.includes("--child") ? child(argv) : main(argv)).catch((e) => {
    console.error(e);
    process.exit(2);
  });
}

module.exports = { loadScenarios, score, wilson, judge, writeReport, simulateMe };
