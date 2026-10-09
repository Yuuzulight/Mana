// #1407: once one of her merged PRs is deployed (her live copy runs it),
// the behaviour evals (#1392) run once for that change: 3 repeats against
// the latest passing report. This only picks the moment and records the
// verdict on #1386's lifecycle: a failed gate marks the issue regressed,
// which holds it, and tells me. It never reverts anything.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");

const EVAL = path.join(__dirname, "bench", "behavior-eval.js");
const RESULTS = path.join(__dirname, "bench", "results");
const MAX_TRIES = 3;

// The newest behaviour-eval report.json that passed its gate, or null.
function latestBaseline(dir = RESULTS) {
  let best = null;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {}
  for (const name of names) {
    const file = path.join(dir, name, "report.json");
    try {
      const at = fs.statSync(file).mtimeMs;
      if (best && at <= best.at) continue;
      const r = JSON.parse(fs.readFileSync(file, "utf8"));
      if (r.gate?.passed === true && Array.isArray(r.scenarios)) best = { file, at };
    } catch {}
  }
  return best?.file || null;
}

// The eval itself, below normal priority; resolves with its exit code
// (0 passed, 1 failed its gate, 2 couldn't run).
function runEval({ head, label, baseline }) {
  return new Promise((resolve) => {
    const args = [EVAL, "--ref", head, "--repeat", "3", "--label", label, ...(baseline ? ["--baseline", baseline] : [])];
    const child = spawn(process.execPath, args, { cwd: __dirname, windowsHide: true, stdio: "ignore" });
    try {
      os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {}
    child.on("error", () => resolve(2));
    child.on("exit", (code) => resolve(code ?? 2));
  });
}

function gitIn(repoRoot) {
  return (args) =>
    new Promise((resolve, reject) =>
      execFile("git", args, { cwd: repoRoot, windowsHide: true }, (e, stdout) => (e ? reject(e) : resolve(String(stdout).trim()))),
    );
}

// blocked: async () => why not now, or null (game, RAM, her model loaded, her own work).
function createPostDeployEval({ lifecycle, repoRoot, stateFile, blocked, notify = () => {}, run = runEval, git = gitIn(repoRoot), resultsDir = RESULTS }) {
  let running = null;
  const load = () => {
    try {
      return JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
      return {};
    }
  };
  const save = (s) => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
  };

  // Her merged issues whose merge commit the live copy runs.
  async function deployed(head) {
    const out = [];
    for (const r of lifecycle.list()) {
      if (r.state !== "merged" || !r.mergeCommit) continue;
      if (await git(["merge-base", "--is-ancestor", r.mergeCommit, head]).then(() => true, () => false)) out.push(r);
    }
    return out;
  }

  function finish(code, head, label, records) {
    const state = load();
    const prs = records.flatMap((r) => r.prs.slice(-1).map((n) => `#${n}`)).join(", ");
    if (code === 2) {
      // Couldn't run (something took the machine between my check and its own): next idle period, a few times.
      const tries = (state.head === head ? state.tries || 0 : 0) + 1;
      if (tries < MAX_TRIES) return save({ ...state, head, tries });
      save({ evaluated: head, head, tries });
      return notify(`I couldn't run my behaviour evals after deploying ${prs} (${tries} tries), so they're still unverified. The last try is in bench/results/${label} if it got that far.`);
    }
    const report = JSON.parse(fs.readFileSync(path.join(resultsDir, label, "report.json"), "utf8"));
    for (const r of records) lifecycle.verify(r.issue, { ...report, label });
    save({ evaluated: head, head });
    if (report.gate?.passed !== true) {
      const why = (report.gate?.failures || []).slice(0, 3).join("; ");
      notify(`My behaviour evals got worse after deploying ${prs}: ${why}. I've held ${records.map((r) => `#${r.issue}`).join(", ")} until you look; the report is in bench/results/${label}. Nothing was reverted.`);
    }
  }

  // True while an eval runs or one just started: the idle picker leaves her model's VRAM alone.
  async function maybeRun() {
    if (running) return true;
    const head = await git(["rev-parse", "HEAD"]);
    if (load().evaluated === head) return false;
    const records = await deployed(head);
    if (!records.length || (await blocked())) return false;
    const label = `post-deploy-${head.slice(0, 8)}`;
    const baseline = latestBaseline(resultsDir);
    running = run({ head, label, baseline })
      .then((code) => finish(code, head, label, records))
      .catch((e) => console.warn(`[post-deploy eval] ${e.message}`))
      .finally(() => {
        running = null;
      });
    return true;
  }

  return { maybeRun, running: () => running !== null };
}

module.exports = { createPostDeployEval, latestBaseline };
