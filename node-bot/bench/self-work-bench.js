// #1203 (part of #1202): a fixed benchmark for self-work. Each case in
// bench/cases is a merged fix whose test fails at the fix's parent. Mana
// gets the issue's text in a throwaway worktree at that parent and
// self-work's own loop runs on it in bench mode (no push, no PR, no gh);
// then the fix's tests are copied in and run, and a JSON + Markdown report
// says how she did. One case at a time, at below-normal priority, on her
// chat model in a llama-server of the bench's own (never the backend's).
//
//   node bench/self-work-bench.js [--case <id>]... [--verify] [--out <dir>]
//
// --verify checks the cases themselves instead: the hidden tests fail at
// the base commit and pass with the fix's files.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { createSelfWork, testEnv, systemRamPercent } = require("../self-work");

const CASES_DIR = path.join(__dirname, "cases");
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

function loadCases(dir = CASES_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
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

function copyHiddenTests(repoRoot, wt, c) {
  for (const rel of c.hiddenTests) {
    const full = path.join(wt, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, git(repoRoot, "show", `${c.fix}:${rel}`) + "\n");
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
// counter the model's fetch adds to).
async function runCase(c, deps) {
  const { repoRoot, worktreesDir } = deps;
  const wt = path.join(worktreesDir, `bench-${c.id}`);
  makeWorktree(repoRoot, wt, c.base);
  const tokens = deps.tokens || { prompt: 0, completion: 0, peak: 0, textCalls: 0 };
  tokens.peak = 0;
  const before = { ...tokens };
  try {
    // Counted here, so a loop that throws still reports what it did.
    const calls = { total: 0, errors: 0 };
    const counted = (policy) => ({
      ...policy,
      async executeTool(name, args) {
        calls.total += 1;
        try {
          return await policy.executeTool(name, args);
        } catch (e) {
          calls.errors += 1;
          throw e;
        }
      },
    });
    const selfWork = createSelfWork({
      repoRoot,
      worktreesDir,
      runLoop: (prompt, policy, opts) => deps.runLoop(prompt, counted(policy), opts),
      reviewEdit: deps.reviewEdit,
      isGaming: deps.isGaming,
      ramPercent: deps.ramPercent,
      runTests: deps.runTests,
      onEvent: deps.onEvent || ((run, text) => console.log(`[bench ${c.id}] ${text}`)),
    });
    // The interface the hidden tests call (names, options, messages), when
    // the issue leaves it open, so a sound fix isn't failed on naming.
    const body = c.interface ? `${c.body}\n\nThe tests for this will use: ${c.interface}` : c.body;
    const started = Date.now();
    const { reply, run, error } = await selfWork.bench({ number: c.issue, title: c.title, body }, wt);
    const wallMs = Date.now() - started;
    const diff = diffAgainst(wt, c.base);
    const allowed = new Set([...c.fixFiles, ...c.hiddenTests]);
    copyHiddenTests(repoRoot, wt, c);
    const hidden = runHiddenTests(wt, c);
    return {
      id: c.id,
      passed: hidden.passed,
      rounds: run.round,
      toolCalls: calls.total,
      // Calls that threw: a bad path, an edit whose old_text didn't match.
      toolErrors: calls.errors,
      wallMs,
      tokens: {
        prompt: tokens.prompt - before.prompt,
        completion: tokens.completion - before.completion,
        // The biggest single prompt: how close she came to the context.
        peak: tokens.peak,
        // Replies with a tool call written into the text instead of tool_calls.
        textCalls: tokens.textCalls - before.textCalls,
      },
      diff: { files: diff.files, added: diff.added, removed: diff.removed },
      outside: diff.files.filter((f) => !allowed.has(f)),
      // How her loop ended: finished, or why not.
      ended: error
        ? "error"
        : run.halt?.state ||
          (run.refuted ? "refuted" : run.finished && !/^Not done yet/i.test(reply?.content || "") ? "finished" : "not-finished"),
      lastTestPassed: run.lastTestPassed,
      error: error ? error.slice(0, 300) : undefined,
      summary: String(reply?.content || "").slice(0, 600),
      patch: diff.patch,
      hiddenTail: hidden.passed ? "" : hidden.tail,
    };
  } finally {
    removeWorktree(repoRoot, wt);
  }
}

// The case itself is sound: its hidden tests fail at the base and pass
// once the fix's own files are in.
function verifyCase(c, { repoRoot, worktreesDir }) {
  const wt = path.join(worktreesDir, `bench-verify-${c.id}`);
  makeWorktree(repoRoot, wt, c.base);
  try {
    copyHiddenTests(repoRoot, wt, c);
    const atBase = runHiddenTests(wt, c);
    git(wt, "checkout", c.fix, "--", ...c.fixFiles);
    const withFix = runHiddenTests(wt, c);
    return { id: c.id, ok: !atBase.passed && withFix.passed, failsAtBase: !atBase.passed, passesWithFix: withFix.passed, tail: withFix.passed ? "" : withFix.tail };
  } finally {
    removeWorktree(repoRoot, wt);
  }
}

function writeReport(results, outDir, meta = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const r of results) if (r.patch) fs.writeFileSync(path.join(outDir, `${r.id}.diff`), r.patch + "\n");
  const rows = results.map(({ patch, ...r }) => r);
  const passed = rows.filter((r) => r.passed).length;
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({ ...meta, passed, total: rows.length, results: rows }, null, 2));
  const tok = (t) => (t.prompt || t.completion ? `${t.prompt} / ${t.completion} / ${t.peak}` : "n/a");
  const md = [
    `# Self-work benchmark${meta.label ? `: ${meta.label}` : ""}`,
    "",
    `${passed}/${rows.length} hidden tests passing.${meta.model ? ` Model: ${meta.model}.` : ""}`,
    "",
    "| Case | Hidden test | Ended | Rounds | Tool calls (errors) | Wall | Tokens (prompt / out / peak) | Calls in text | Diff (+/-, files) | Outside the fix's files |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.passed ? "pass" : "fail"} | ${r.ended} | ${r.rounds} | ${r.toolCalls} (${r.toolErrors}) | ${Math.round(r.wallMs / 1000)}s | ${tok(r.tokens)} | ${r.tokens.textCalls ?? 0} | +${r.diff.added}/-${r.diff.removed}, ${r.diff.files.length} | ${r.outside.length ? r.outside.join(", ") : "no"} |`,
    ),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "report.md"), md);
  return md;
}

// Her chat model in a llama-server of the bench's own, from node-bot/.env.
// Tokens come from each reply's usage; a reply whose tool call stayed in
// its text (no tool_calls) is counted too.
function realModel(repoRoot, tokens) {
  const { parseEnv } = require("node:util");
  const { createLlamaServerRuntime } = require("../ai/llama-server-runtime");
  const { refuteEdit } = require("../ai/adversarial-verifier");
  const envFile = path.join(repoRoot, "node-bot", ".env");
  const env = { ...process.env, ...(fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, "utf8")) : {}) };
  env.LLAMA_SERVER_PORT = BENCH_LLAMA_PORT;
  // Text only: no vision projector taking VRAM, and no host-RAM prompt
  // cache (one conversation at a time reuses its slot's KV cache anyway).
  delete env.LLAMA_VISION_MODEL;
  delete env.LLAMA_VISION_MMPROJ;
  env.LLAMA_CACHE_RAM = "0";
  const fetch = async (url, init) => {
    const resp = await globalThis.fetch(url, init);
    if (resp.ok && /\/v1\/chat\/completions$/.test(url)) {
      const json = await resp.clone().json().catch(() => null);
      const prompt = Number(json?.usage?.prompt_tokens) || 0;
      tokens.prompt += prompt;
      tokens.completion += Number(json?.usage?.completion_tokens) || 0;
      tokens.peak = Math.max(tokens.peak, prompt);
      const message = json?.choices?.[0]?.message;
      if (message && !message.tool_calls?.length && /<function=|<tool_call>|"arguments"\s*:/.test(message.content || "")) {
        tokens.textCalls += 1;
      }
    }
    return resp;
  };
  const runtime = createLlamaServerRuntime({ env, threads: env.LLAMA_THREADS, fetch });
  return {
    model: path.basename(runtime.findLlamaModel("default") || env.LLAMA_MODEL || "?"),
    runLoop: (...args) => runtime.runToolAwareReply(...args),
    reviewEdit: (proposal) => refuteEdit({ ...proposal, runLocalReply: runtime.runLocalReplyIfSafelyLoaded, env }),
    stop: () => runtime.stop(),
  };
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
  const cases = loadCases().filter((c) => !wanted.length || wanted.includes(c.id));
  if (!cases.length) throw new Error("no such case");
  const outDir = opt("--out")[0] || path.join(os.tmpdir(), "mana-self-work-bench", new Date().toISOString().replace(/[:.]/g, "-"));
  const gate = {
    isGaming: () => isGamingNow(repoRoot),
    ramPercent: systemRamPercent,
    backendModelUp: () =>
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
  const model = realModel(repoRoot, tokens);
  const results = [];
  try {
    for (const c of cases) {
      // Wait out a game, a RAM spike or her chat model for up to 20 minutes.
      let why = await blocker(gate);
      for (let waited = 0; why && waited < 20; waited += 1) {
        console.log(`Waiting before ${c.id}: ${why}.`);
        await new Promise((resolve) => setTimeout(resolve, 60000));
        why = await blocker(gate);
      }
      if (why) {
        console.log(`Stopping before ${c.id}: ${why}.`);
        break;
      }
      const result = await runCase(c, { repoRoot, worktreesDir, ...gate, ...model, tokens });
      // No room for the model (the backend's chat model is loaded, say):
      // not her result, so the run stops here instead of scoring it.
      if (/refusing to load/.test(result.error || "")) {
        console.log(`Stopping at ${c.id}: ${result.error}`);
        break;
      }
      results.push(result);
      writeReport(results, outDir, { model: model.model, label: opt("--label")[0] });
    }
  } finally {
    await model.stop();
  }
  console.log(writeReport(results, outDir, { model: model.model, label: opt("--label")[0] }));
  console.log(`Report: ${outDir}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}

module.exports = { loadCases, runCase, verifyCase, writeReport, makeWorktree, removeWorktree };
