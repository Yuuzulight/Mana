// #1203 (part of #1202): a fixed benchmark for self-work. Each case in
// bench/cases is a merged fix whose test fails at the fix's parent. Mana
// gets the issue's text in a throwaway worktree at that parent and
// self-work's own loop runs on it in bench mode (no push, no PR, no gh);
// then the fix's tests are copied in and run, and a JSON + Markdown report
// says how she did. One case at a time, at below-normal priority, on her
// chat model in a llama-server of the bench's own (never the backend's).
//
//   node bench/self-work-bench.js [--case <id>]... [--kind <kind>]...
//     [--repeat N] [--model <gguf>] [--context N] [--max-minutes N] [--label <name>]
//     [--server-args "<extra llama-server flags, space- or comma-separated>"] [--attempts N]
//     [--out <dir>] [--verify]
//     [--cases <dir>]   (bench/generated/cases for bench/gen's tasks)
//
// #1221: cases have a kind (node-bug, node-feature, multi-file, launcher,
// live); each runs --repeat times (model output varies); --model and
// --context pick the configuration. The report (bench/results/<label> by
// default) has pass@1, pass@k and the spread per configuration and kind, a
// failure kind for each failed run, and its cost (wall, rounds, calls,
// tokens, peak VRAM and RAM).
//
// --verify checks the cases themselves instead: the hidden tests fail at
// the base commit and pass with the fix's files. A live case (no merged
// fix yet, fix: null) keeps its hidden tests in bench/hidden/<id>/ and
// only has to fail at the base. A case with a fix can keep its hidden tests
// there too, when the fix's own tests don't check the behaviour.
//
// #1269: --gemini runs only her Gemini CLI fallback on each case (no local
// model, nothing of hers after it), to measure Gemini on its own. It needs
// Gemini CLI installed and signed in, and spends real quota: each case is
// one run of many requests. MANA_SELF_WORK_GEMINI_MODEL picks the model;
// --model, --context, --server-args and --attempts don't apply.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { createSelfWork, testEnv, systemRamPercent } = require("../self-work");
const { createGeminiFallback } = require("../gemini-fallback");

const CASES_DIR = path.join(__dirname, "cases");
const HIDDEN_DIR = path.join(__dirname, "hidden");
const RESULTS_DIR = path.join(__dirname, "results");
const HIDDEN_TEST_TIMEOUT_MS = 10 * 60 * 1000;
// Not the backend's 8090, so the two never share a server.
const BENCH_LLAMA_PORT = "8097";
const BACKEND_LLAMA_PORT = 8090;
// The bench's own limit for starting a case (self-work's 85% inside her
// run is unchanged).
const BENCH_MAX_RAM_PERCENT = 90;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: "pipe", maxBuffer: 64 * 1024 * 1024 }).trim();
}

// #1249: a case's id names its worktree folder and its hidden tests are
// written and deleted inside one, so neither may be absolute or climb out.
const badPath = (p) => typeof p !== "string" || !p || path.posix.isAbsolute(p) || path.win32.isAbsolute(p) || p.split(/[\\/]/).includes("..");

function loadCases(dir = CASES_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const c = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (!/^[\w.-]+$/.test(String(c.id)) || String(c.id).includes("..")) throw new Error(`${f}: bad case id ${JSON.stringify(c.id)}`);
      const bad = (c.hiddenTests || []).find(badPath);
      if (bad !== undefined) throw new Error(`${f}: hidden test ${JSON.stringify(bad)} must be a relative path inside the repo`);
      // A live case's hidden tests live in the bench folder; so do a fixed
      // case's when that folder exists.
      const hiddenFrom = path.join(HIDDEN_DIR, c.id);
      return c.fix && !fs.existsSync(hiddenFrom) ? c : { hiddenFrom, ...c };
    });
}

// A detached worktree at the base commit, with node-bot's packages linked in.
function makeWorktree(repoRoot, wt, base) {
  if (fs.existsSync(wt)) removeWorktree(repoRoot, wt);
  git(repoRoot, "worktree", "add", "--detach", wt, base);
  const modules = path.join(repoRoot, "node-bot", "node_modules");
  if (fs.existsSync(modules)) fs.symlinkSync(fs.realpathSync(modules), path.join(wt, "node-bot", "node_modules"), "junction");
}

// The junction goes first and on its own, so nothing recurses into the
// live packages behind it. (A non-recursive Directory.Delete can only
// remove the link, or fail on a real folder.)
function removeWorktree(repoRoot, wt) {
  const link = path.join(wt, "node-bot", "node_modules");
  if (fs.existsSync(link)) {
    if (process.platform === "win32") {
      execFileSync("powershell", ["-NoProfile", "-Command", `[System.IO.Directory]::Delete('${link.replace(/'/g, "''")}')`], {
        windowsHide: true,
      });
    } else {
      fs.unlinkSync(link);
    }
  }
  try {
    git(repoRoot, "worktree", "remove", "--force", wt);
  } catch {
    fs.rmSync(wt, { recursive: true, force: true });
    git(repoRoot, "worktree", "prune");
  }
}

// #1231: a generated case is a bug patched into the base (its `mutation`),
// with the tests that catch it taken out until she's done, committed in the
// throwaway worktree so a reset to HEAD (her best-of-N) keeps both. Returns
// what her diff is taken against: that commit, or the base for a real case.
function applyMutation(wt, c) {
  if (!c.mutation) return c.base;
  execFileSync("git", ["apply", "--whitespace=nowarn"], { cwd: wt, input: c.mutation, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  for (const rel of c.hiddenTests) fs.rmSync(path.join(wt, rel), { force: true });
  git(wt, "add", "-A");
  git(wt, "-c", "user.name=bench", "-c", "user.email=bench@localhost", "commit", "-q", "--no-verify", "-m", `bench: ${c.id}`);
  return git(wt, "rev-parse", "HEAD");
}

// From its hiddenFrom folder when it has one, else the fix's commit.
function copyHiddenTests(repoRoot, wt, c) {
  for (const rel of c.hiddenTests) {
    const full = path.join(wt, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const text = c.hiddenFrom ? fs.readFileSync(path.join(c.hiddenFrom, rel), "utf8") : git(repoRoot, "show", `${c.fix}:${rel}`) + "\n";
    fs.writeFileSync(full, text);
  }
}

function runHiddenTests(wt, c) {
  const started = Date.now();
  const r = spawnSync(c.testCommand, {
    cwd: path.join(wt, "node-bot"),
    shell: true,
    windowsHide: true,
    encoding: "utf8",
    env: testEnv(process.env),
    timeout: HIDDEN_TEST_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${r.stdout || ""}${r.stderr || ""}`;
  return { passed: r.status === 0, ms: Date.now() - started, tail: output.slice(-1500) };
}

// Everything she changed against the base, as the PR would carry it.
function diffAgainst(wt, base) {
  git(wt, "add", "-A");
  const files = [];
  let added = 0;
  let removed = 0;
  for (const line of git(wt, "-c", "core.quotePath=false", "diff", "--cached", "--numstat", "--no-renames", base).split(/\r?\n/)) {
    const [a, d, file] = line.split("\t");
    if (!file) continue;
    files.push(file);
    added += Number(a) || 0;
    removed += Number(d) || 0;
  }
  return { files, added, removed, patch: git(wt, "diff", "--cached", base) };
}

function isGamingNow(repoRoot) {
  if (process.platform !== "win32") return false;
  const names = require("../game-wikis").loadGameWikis(path.join(repoRoot, "node-bot", "data", "game-wikis.json")).processes;
  const running = execFileSync("tasklist", ["/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).toLowerCase();
  return names.some((n) => running.includes(`"${n}"`));
}

// Why a case shouldn't start now, or null. The backend's own chat model
// being up means she's in use: the bench's model would take the VRAM her
// next reply needs.
async function blocker({ isGaming, ramPercent, backendModelUp }) {
  if (isGaming()) return "a game is running";
  const ram = ramPercent();
  if (ram > BENCH_MAX_RAM_PERCENT) return `RAM is at ${ram}%`;
  if (await backendModelUp()) return "the backend's chat model is loaded";
  return null;
}

// One case. deps: repoRoot, worktreesDir, runLoop, and optionally
// reviewEdit, isGaming, ramPercent, runTests, tokens (a {prompt, completion,
// peak, textCalls}
// counter the model's fetch adds to), gemini (#1269: her Gemini fallback,
// run on the case instead of her loop).
async function runCase(c, deps) {
  const { repoRoot, worktreesDir } = deps;
  const wt = path.join(worktreesDir, `bench-${c.id}`);
  makeWorktree(repoRoot, wt, c.base);
  const tokens = deps.tokens || { prompt: 0, completion: 0, peak: 0, textCalls: 0 };
  tokens.peak = 0;
  const before = { ...tokens };
  try {
    const start = applyMutation(wt, c);
    // Counted here, so a loop that throws still reports what it did.
    const calls = { total: 0, errors: 0, editErrors: 0, samples: [] };
    const counted = (policy) => ({
      ...policy,
      async executeTool(name, args) {
        calls.total += 1;
        try {
          return await policy.executeTool(name, args);
        } catch (e) {
          calls.errors += 1;
          if (name === "coding__propose_edit") calls.editErrors += 1;
          // What went wrong, for the report: the first few.
          if (calls.samples.length < 5) calls.samples.push(`${name}: ${String(e.message).slice(0, 160)}`);
          throw e;
        }
      },
    });
    const peaks = watchPeaks(deps.sample);
    const selfWork = createSelfWork({
      repoRoot,
      worktreesDir,
      // A wall-clock cap per run (goal mode ends gracefully at it), so one
      // run of full-suite test runs can't hold the batch for an hour.
      runLoop: (prompt, policy, opts) => deps.runLoop(prompt, counted(policy), deps.maxMs ? { ...opts, maxMs: deps.maxMs } : opts),
      reviewEdit: deps.reviewEdit,
      isGaming: deps.isGaming,
      ramPercent: deps.ramPercent,
      runTests: deps.runTests,
      approvalGate: deps.approvalGate,
      gemini: deps.gemini || null,
      onEvent: deps.onEvent || ((run, text) => console.log(`[bench ${c.id}] ${text}`)),
    });
    // The interface the hidden tests call (names, options, messages), when
    // the issue leaves it open, so a sound fix isn't failed on naming.
    const body = c.interface ? `${c.body}\n\nThe tests for this will use: ${c.interface}` : c.body;
    const started = Date.now();
    const issue = { number: c.issue, title: c.title, body };
    // #1247: --attempts N is her best-of-N (where self-work has it).
    const { reply, run, error, gemini } = deps.gemini
      ? await selfWork.benchGemini(issue, wt)
      : await selfWork.bench(issue, wt, { attempts: deps.attempts || 1 });
    const wallMs = Date.now() - started;
    const peak = await peaks.stop();
    const contextSize = deps.contextSize ? await deps.contextSize() : null;
    const diff = diffAgainst(wt, start);
    const allowed = new Set([...c.fixFiles, ...c.hiddenTests]);
    copyHiddenTests(repoRoot, wt, c);
    const hidden = runHiddenTests(wt, c);
    const result = {
      id: c.id,
      kind: c.kind || "",
      repeat: deps.repeat || 1,
      passed: hidden.passed,
      rounds: run.round,
      maxRounds: run.maxRounds,
      attempts: run.attempts?.length || 1,
      toolCalls: calls.total,
      // Calls that threw: a bad path, an edit whose old_text didn't match.
      toolErrors: calls.errors,
      editErrors: calls.editErrors,
      errorSamples: calls.samples,
      wallMs,
      peakVramMb: peak.vramMb,
      peakRamPercent: peak.ramPercent,
      contextSize,
      tokens: {
        prompt: tokens.prompt - before.prompt,
        completion: tokens.completion - before.completion,
        // The biggest single prompt: how close she came to the context.
        peak: tokens.peak,
        // Replies with a tool call written into the text instead of tool_calls.
        textCalls: tokens.textCalls - before.textCalls,
        // Generated tokens per second over the run.
        tps: tokens.genMs > (before.genMs || 0) ? Math.round(((tokens.genN - (before.genN || 0)) / (tokens.genMs - (before.genMs || 0))) * 10000) / 10 : null,
      },
      diff: { files: diff.files, added: diff.added, removed: diff.removed },
      outside: diff.files.filter((f) => !allowed.has(f)),
      // How her loop ended: finished, or why not.
      ended: gemini
        ? gemini.refused.length
          ? "refused"
          : gemini.outcome
        : error
          ? "error"
          : run.halt?.state ||
            (run.refuted ? "refuted" : run.finished && !/^Not done yet/i.test(reply?.content || "") ? "finished" : "not-finished"),
      lastTestPassed: run.lastTestPassed,
      error: error ? error.slice(0, 300) : undefined,
      summary: String(reply?.content || "").slice(0, 600),
      patch: diff.patch,
      hiddenTail: hidden.passed ? "" : hidden.tail,
    };
    result.failure = failureKind(result, c);
    return result;
  } finally {
    removeWorktree(repoRoot, wt);
  }
}

// #1221: why a run failed, first match wins. Scope creep is a failed run
// that touched files the real fix didn't (a passing one only notes it).
function failureKind(r, c) {
  if (r.passed) return null;
  const overflow = /outgrew the model's context|exceeds the available context/i.test(`${r.summary} ${r.error || ""}`);
  if (overflow || (r.contextSize && r.tokens.peak >= 0.78 * r.contextSize)) return "context overflow";
  if (r.ended === "stuck") return "stuck";
  if (r.ended === "refuted") return "no valid edit: reviewer refusal";
  if (/parse tool call/i.test(r.error || "")) return "no valid edit: parse failure";
  if (r.ended === "error") return "error";
  // #1269: a Gemini run that ended without its change being scored.
  if (r.ended === "refused") return "refused: outside her write rules";
  if (["quota", "timeout", "turn-limit", "missing"].includes(r.ended)) return `gemini: ${r.ended}`;
  if (!r.diff.files.length) {
    if (r.editErrors) return "no valid edit: bad arguments";
    // The forced final answer after the last round often holds one more
    // call in its text; that's running out of rounds, not a parse failure.
    if (r.maxRounds && r.rounds >= r.maxRounds) return "out of rounds";
    if (r.tokens.textCalls) return "no valid edit: parse failure";
    return "no valid edit";
  }
  const code = c.fixFiles.filter((f) => /\.(js|cs|ts|ps1|py)$/.test(f));
  if (code.length && !r.diff.files.some((f) => code.includes(f))) return "wrong file";
  if (r.maxRounds && r.rounds >= r.maxRounds && r.ended !== "finished") return "out of rounds";
  if (r.outside.length) return "scope creep";
  return "tests fail";
}

// Peak VRAM (MB used, from nvidia-smi) and system RAM while a case runs.
// sample: async () => ({ vramMb, ramPercent }), every 5 seconds.
function watchPeaks(sample) {
  const peak = { vramMb: null, ramPercent: null };
  if (!sample) return { stop: async () => peak };
  const take = async () => {
    const s = await sample().catch(() => null);
    if (!s) return;
    if (s.vramMb != null) peak.vramMb = Math.max(peak.vramMb ?? 0, s.vramMb);
    if (s.ramPercent != null) peak.ramPercent = Math.max(peak.ramPercent ?? 0, s.ramPercent);
  };
  const first = take();
  const timer = setInterval(take, 5000);
  return {
    async stop() {
      clearInterval(timer);
      await first;
      await take();
      return peak;
    },
  };
}

function sampleMachine() {
  const { execFile } = require("node:child_process");
  return new Promise((resolve) => {
    execFile("nvidia-smi", ["--query-gpu=memory.used", "--format=csv,noheader,nounits"], { windowsHide: true }, (err, out) => {
      resolve({ vramMb: err ? null : Number(String(out).trim().split(/\r?\n/)[0]) || null, ramPercent: systemRamPercent() });
    });
  });
}

// The case itself is sound: its hidden tests fail at the base and pass
// once the fix's own files are in.
function verifyCase(c, { repoRoot, worktreesDir }) {
  const wt = path.join(worktreesDir, `bench-verify-${c.id}`);
  makeWorktree(repoRoot, wt, c.base);
  try {
    applyMutation(wt, c);
    copyHiddenTests(repoRoot, wt, c);
    const atBase = runHiddenTests(wt, c);
    if (!c.fix) return { id: c.id, ok: !atBase.passed, failsAtBase: !atBase.passed, passesWithFix: null, tail: atBase.tail };
    git(wt, "checkout", c.fix, "--", ...c.fixFiles);
    const withFix = runHiddenTests(wt, c);
    return { id: c.id, ok: !atBase.passed && withFix.passed, failsAtBase: !atBase.passed, passesWithFix: withFix.passed, tail: withFix.passed ? "" : withFix.tail };
  } finally {
    removeWorktree(repoRoot, wt);
  }
}

// #1221: pass@1 (the mean over repeats), pass@k (passed in any repeat)
// and the spread (fewest and most passes in one repeat), overall and by
// kind; failure kinds; and the mean cost of a run.
function summarize(results) {
  const repeats = [...new Set(results.map((r) => r.repeat || 1))];
  const ids = [...new Set(results.map((r) => r.id))];
  const of = (rows) => {
    const cases = [...new Set(rows.map((r) => r.id))];
    const perRepeat = repeats.map((k) => rows.filter((r) => (r.repeat || 1) === k && r.passed).length);
    const anyPass = cases.filter((id) => rows.some((r) => r.id === id && r.passed)).length;
    return {
      cases: cases.length,
      pass1: cases.length ? perRepeat.reduce((a, b) => a + b, 0) / repeats.length / cases.length : 0,
      passK: cases.length ? anyPass / cases.length : 0,
      spread: [Math.min(...perRepeat), Math.max(...perRepeat)],
    };
  };
  const kinds = [...new Set(results.map((r) => r.kind || ""))].sort();
  const failures = {};
  for (const r of results) if (r.failure) failures[r.failure] = (failures[r.failure] || 0) + 1;
  const mean = (f) => {
    const v = results.map(f).filter((x) => typeof x === "number");
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  return {
    repeats: repeats.length,
    cases: ids.length,
    runs: results.length,
    overall: of(results),
    byKind: Object.fromEntries(kinds.map((k) => [k, of(results.filter((r) => (r.kind || "") === k))])),
    failures,
    cost: {
      wallS: mean((r) => r.wallMs / 1000),
      rounds: mean((r) => r.rounds),
      toolCalls: mean((r) => r.toolCalls),
      promptTokens: mean((r) => r.tokens.prompt),
      outTokens: mean((r) => r.tokens.completion),
      peakPrompt: mean((r) => r.tokens.peak),
      tps: mean((r) => r.tokens.tps),
      peakVramMb: mean((r) => r.peakVramMb),
      peakRamPercent: mean((r) => r.peakRamPercent),
    },
  };
}

const pct = (x) => `${Math.round(x * 100)}%`;

function writeReport(results, outDir, meta = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const name = (r) => (meta.repeats > 1 ? `${r.id}-r${r.repeat}` : r.id);
  for (const r of results) if (r.patch) fs.writeFileSync(path.join(outDir, `${name(r)}.diff`), r.patch + "\n");
  const rows = results.map(({ patch, ...r }) => r);
  const summary = summarize(rows);
  const passed = rows.filter((r) => r.passed).length;
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({ ...meta, passed, total: rows.length, summary, results: rows }, null, 2));
  const tok = (t) => (t.prompt || t.completion ? `${t.prompt} / ${t.completion} / ${t.peak}` : "n/a");
  const o = summary.overall;
  const c = summary.cost;
  const md = [
    `# Self-work benchmark${meta.label ? `: ${meta.label}` : ""}`,
    "",
    `${meta.model ? `Model: ${meta.model}. ` : ""}${meta.context ? `Context: ${meta.context}. ` : ""}${meta.attempts > 1 ? `Best of ${meta.attempts} attempts. ` : ""}${summary.cases} cases x ${summary.repeats} repeat(s).`,
    "",
    `**pass@1 ${pct(o.pass1)}, pass@${summary.repeats} ${pct(o.passK)}**, passes per repeat ${o.spread[0]}-${o.spread[1]} of ${o.cases}. ${passed}/${rows.length} runs passed.`,
    "",
    "| Kind | Cases | pass@1 | pass@k | Spread |",
    "| --- | --- | --- | --- | --- |",
    ...Object.entries(summary.byKind).map(([k, v]) => `| ${k || "-"} | ${v.cases} | ${pct(v.pass1)} | ${pct(v.passK)} | ${v.spread[0]}-${v.spread[1]} |`),
    "",
    `Failures: ${Object.entries(summary.failures).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}.`,
    "",
    `Mean cost of a run: ${c.wallS}s, ${c.rounds} rounds, ${c.toolCalls} tool calls, ${c.promptTokens} prompt / ${c.outTokens} out tokens, peak prompt ${c.peakPrompt}, ${c.tps ?? "n/a"} tokens/s, peak VRAM ${c.peakVramMb ?? "n/a"} MB, peak RAM ${c.peakRamPercent ?? "n/a"}%.`,
    "",
    "| Case | Kind | Run | Hidden test | Ended | Failure | Rounds | Tool calls (errors) | Wall | Tokens (prompt / out / peak) | Calls in text | Diff (+/-, files) | Outside the fix's files |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.kind || "-"} | ${r.repeat || 1} | ${r.passed ? "pass" : "fail"} | ${r.ended} | ${r.failure || "-"} | ${r.rounds} | ${r.toolCalls} (${r.toolErrors}) | ${Math.round(r.wallMs / 1000)}s | ${tok(r.tokens)} | ${r.tokens.textCalls ?? 0} | +${r.diff.added}/-${r.diff.removed}, ${r.diff.files.length} | ${r.outside.length ? r.outside.join(", ") : "no"} |`,
    ),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "report.md"), md);
  return md;
}

function benchEnv(repoRoot) {
  const { parseEnv } = require("node:util");
  const envFile = path.join(repoRoot, "node-bot", ".env");
  return { ...process.env, ...(fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, "utf8")) : {}) };
}

// #1269: Gemini CLI in place of her model, when it's installed and signed in.
async function geminiModel(repoRoot) {
  const gemini = createGeminiFallback({ env: benchEnv(repoRoot) });
  const s = await gemini.state();
  if (!s.installed || !s.signedIn) throw new Error(s.why);
  return { model: `Gemini CLI ${s.version} (${s.model})`, gemini, start: async () => {}, aborted: () => null, stop: async () => {} };
}

// Her chat model in a llama-server of the bench's own, from node-bot/.env.
// Tokens come from each reply's usage; a reply whose tool call stayed in
// its text (no tool_calls) is counted too.
// #1221: --model swaps the chat model (another GGUF on disk), and
// --context sets the server's context and asks her runs for the same.
// #1221: --server-args starts the bench's llama-server itself with those
// extra flags (a MoE model with its experts in RAM: "-ngl 99 --n-cpu-moe
// 20"); the runtime then adopts it as the server for that model.
function realModel(repoRoot, tokens, { model, context, serverArgs } = {}) {
  const { createLlamaServerRuntime } = require("../ai/llama-server-runtime");
  const { refuteEdit } = require("../ai/adversarial-verifier");
  const env = benchEnv(repoRoot);
  env.LLAMA_SERVER_PORT = BENCH_LLAMA_PORT;
  // Text only: no vision projector taking VRAM, and no host-RAM prompt
  // cache (one conversation at a time reuses its slot's KV cache anyway).
  delete env.LLAMA_VISION_MODEL;
  delete env.LLAMA_VISION_MMPROJ;
  env.LLAMA_CACHE_RAM = "0";
  if (model) env.LLAMA_MODEL = model;
  if (context) {
    env.LLAMA_CONTEXT = String(context);
    process.env.MANA_SELF_WORK_LLAMA_CONTEXT = String(context);
  }
  const fetch = async (url, init) => {
    const resp = await globalThis.fetch(url, init);
    if (resp.ok && /\/v1\/chat\/completions$/.test(url)) {
      const json = await resp.clone().json().catch(() => null);
      const prompt = Number(json?.usage?.prompt_tokens) || 0;
      tokens.prompt += prompt;
      tokens.completion += Number(json?.usage?.completion_tokens) || 0;
      tokens.peak = Math.max(tokens.peak, prompt);
      // Generation speed, from llama-server's timings.
      tokens.genN = (tokens.genN || 0) + (Number(json?.timings?.predicted_n) || 0);
      tokens.genMs = (tokens.genMs || 0) + (Number(json?.timings?.predicted_ms) || 0);
      const message = json?.choices?.[0]?.message;
      if (message && !message.tool_calls?.length && /<function=|<tool_call>|"arguments"\s*:/.test(message.content || "")) {
        tokens.textCalls += 1;
      }
    }
    return resp;
  };
  // With --server-args the bench owns the server: the runtime may only
  // adopt it, never start one of its own (the model with default flags).
  const refuse = () => {
    throw new Error("the bench's own llama-server isn't running");
  };
  // Its VRAM check would only see the bench's own server holding the card.
  if (serverArgs) env.LLAMA_SERVER_VRAM_GUARD = "0";
  const runtime = createLlamaServerRuntime({ env, threads: env.LLAMA_THREADS, fetch, ...(serverArgs ? { spawn: refuse } : {}) });
  let server = null;
  // A server the bench starts itself (a model whose experts sit in RAM)
  // is killed the moment RAM passes the bench's limit; the run then stops.
  const watch = { aborted: null, timer: null };
  async function start() {
    if (!serverArgs) return;
    watch.timer = setInterval(() => {
      const ram = systemRamPercent();
      if (ram > BENCH_MAX_RAM_PERCENT && running(server)) {
        watch.aborted = `RAM reached ${ram}%, so the bench stopped its llama-server`;
        console.log(watch.aborted);
        server.kill();
      }
    }, 250);
    const { spawn } = require("node:child_process");
    const args = ["-m", runtime.findLlamaModel("default"), "--host", "127.0.0.1", "--port", BENCH_LLAMA_PORT, "-c", String(context || env.LLAMA_CONTEXT || 16384)];
    args.push("--no-webui", "--cache-ram", "0", "-t", String(env.LLAMA_THREADS || 4), ...serverArgs.split(/[\s,]+/).filter(Boolean));
    console.log(`Starting the bench's llama-server: ${args.join(" ")}`);
    server = spawn(runtime.findLlamaServerBin(), args, { windowsHide: true, stdio: "ignore" });
    await waitUp(server, () => globalThis.fetch(`http://127.0.0.1:${BENCH_LLAMA_PORT}/health`).then((r) => r.ok, () => false));
  }
  return {
    start,
    model: path.basename(runtime.findLlamaModel("default") || env.LLAMA_MODEL || "?"),
    runLoop: (...args) => runtime.runToolAwareReply(...args),
    reviewEdit: (proposal) => refuteEdit({ ...proposal, runLocalReply: runtime.runLocalReplyIfSafelyLoaded, env }),
    contextSize: () => runtime.getContextSize(),
    aborted: () => watch.aborted,
    async stop() {
      clearInterval(watch.timer);
      await runtime.stop();
      // Wait for it to exit: a reload right after would otherwise race the
      // old server for the port (or get its /health answer).
      if (running(server)) {
        const exited = require("node:events").once(server, "exit");
        server.kill();
        await exited;
      }
    },
  };
}

// A child killed by a signal keeps exitCode null and gets a signalCode.
function running(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

// Polls /health until the server answers; stops as soon as it has exited.
async function waitUp(server, healthy, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  for (let waited = 0; waited < 600; waited += 2) {
    if (await healthy()) return;
    if (!running(server)) throw new Error(`the bench's llama-server exited (${server.exitCode ?? server.signalCode})`);
    await sleep(2000);
  }
  throw new Error("the bench's llama-server didn't come up in 10 minutes");
}

// #1278: wait out a game, a RAM spike or her chat model for up to 20
// minutes, with the bench's model unloaded meanwhile so the game gets the
// VRAM back; it's loaded again once the case can start (without
// --server-args the runtime reloads it on the case's first request).
// Returns why the case still can't start, or null.
async function waitOut(c, gate, model, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  let why = await blocker(gate);
  if (!why) return null;
  await model.stop();
  for (let waited = 0; why && waited < 20; waited += 1) {
    console.log(`Waiting before ${c.id}: ${why}.`);
    await sleep(60000);
    why = await blocker(gate);
  }
  if (!why) await model.start();
  return why;
}

async function main(argv) {
  try {
    os.setPriority(0, 10);
  } catch {}
  const opt = (name) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
  // The main checkout (its .env, packages and data), even when this runs
  // from a worktree; bench worktrees go beside self-work's own.
  const repoRoot = path.dirname(git(__dirname, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  const worktreesDir = path.join(path.dirname(repoRoot), "Mana-worktrees");
  const wanted = opt("--case");
  const kinds = opt("--kind");
  const cases = loadCases(opt("--cases")[0] || CASES_DIR).filter((c) => (!wanted.length || wanted.includes(c.id)) && (!kinds.length || kinds.includes(c.kind)));
  if (!cases.length) throw new Error("no such case");
  const label = opt("--label")[0] || new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = opt("--out")[0] || path.join(RESULTS_DIR, label.replace(/[^\w.-]+/g, "-"));
  const repeats = Math.max(1, Number(opt("--repeat")[0]) || 1);
  const attempts = Math.max(1, Number(opt("--attempts")[0]) || 1);
  // The cap is per attempt.
  const maxMs = (Number(opt("--max-minutes")[0]) || 10) * 60 * 1000;
  const config = { model: opt("--model")[0], context: Number(opt("--context")[0]) || undefined, serverArgs: opt("--server-args")[0] };
  const useGemini = argv.includes("--gemini");
  const gate = {
    isGaming: () => isGamingNow(repoRoot),
    ramPercent: systemRamPercent,
    // Gemini runs in the cloud: her chat model's VRAM isn't in its way.
    backendModelUp: () =>
      !useGemini &&
      fetch(`http://127.0.0.1:${BACKEND_LLAMA_PORT}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false),
  };

  if (argv.includes("--verify")) {
    for (const c of cases) {
      const why = await blocker(gate);
      if (why) throw new Error(`not verifying ${c.id}: ${why}`);
      console.log(JSON.stringify(verifyCase(c, { repoRoot, worktreesDir })));
    }
    return;
  }

  const tokens = { prompt: 0, completion: 0, peak: 0, textCalls: 0 };
  const model = useGemini ? await geminiModel(repoRoot) : realModel(repoRoot, tokens, config);
  const meta = { model: model.model, context: config.context, serverArgs: config.serverArgs, label, repeats, attempts, maxMinutes: maxMs / 60000 };
  const results = [];
  const runs = [];
  for (let repeat = 1; repeat <= repeats; repeat += 1) for (const c of cases) runs.push({ c, repeat });
  try {
    await model.start();
    for (const { c, repeat } of runs) {
      const why = await waitOut(c, gate, model);
      if (why) {
        console.log(`Stopping before ${c.id}: ${why}.`);
        break;
      }
      const result = await runCase(c, { repoRoot, worktreesDir, ...gate, ...model, tokens, repeat, sample: sampleMachine, maxMs, attempts });
      if (model.aborted()) {
        console.log(`Stopping at ${c.id}: ${model.aborted()}.`);
        break;
      }
      // No room for the model (the backend's chat model is loaded, say):
      // not her result, so the run stops here instead of scoring it.
      if (/refusing to load/.test(result.error || "")) {
        console.log(`Stopping at ${c.id}: ${result.error}`);
        break;
      }
      results.push(result);
      if (result.ended === "quota") {
        console.log(`Stopping at ${c.id}: Gemini CLI is out of quota.`);
        break;
      }
      writeReport(results, outDir, meta);
    }
  } finally {
    await model.stop();
  }
  console.log(writeReport(results, outDir, meta).split("\n").slice(0, 14).join("\n"));
  console.log(`Report: ${outDir}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}

module.exports = { loadCases, runCase, verifyCase, writeReport, summarize, failureKind, makeWorktree, removeWorktree, waitOut, waitUp };
