// #1231 (part of #1202): verifiable coding tasks from Mana's own node-bot
// code, for the self-work benchmark and, later, for training on her own
// passing runs. In a throwaway worktree at a base commit:
//   1. a coverage map: each test file's direct requires, kept where a run
//      of that test (which must pass) actually executes the code (V8
//      coverage), so only code a test runs is mutated;
//   2. one-spot bugs from bench/gen/mutate.js, one per function per
//      operator, a few per file, in a seeded order;
//   3. each mutant run against the tests covering it, fastest first; it's
//      kept when the first test file it fails fails only on assertions
//      (not a crash or a timeout);
//   4. an issue a person would file, from the failing tests and the
//      module's header comment, and a case file the bench runner takes
//      (bench/self-work-bench.js --cases <dir>).
// One test file at a time, at below-normal priority, under a RAM limit.
//
//   node bench/gen/generate-tasks.js [--count 200] [--seed 1231] [--per-file 6]
//     [--budget-min 120] [--test-timeout-s 60] [--base HEAD] [--out <dir>]
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { fileURLToPath, pathToFileURL } = require("node:url");
const { edits, mutant, OPERATORS } = require("./mutate");
const { makeWorktree, removeWorktree } = require("../self-work-bench");
const { testEnv } = require("../../ai/git-tool-source");
const { systemRamPercent } = require("../../self-work");
const { killProcessTree } = require("../../utils/kill-process-tree");

// A URL: a bare Windows path reads as a "d:" scheme.
const REPORTER = pathToFileURL(path.join(__dirname, "reporter.js")).href;
const OUT_DIR = path.join(__dirname, "..", "generated");
const MAX_RAM_PERCENT = 90;
// Whole source files, by a hash of the path alone (never the seed), so a
// held-out file stays held out in every batch.
const HELD_OUT_PERCENT = 10;
// Sites tried per function and operator before giving up on that pair.
const TRIES_PER_KEY = 2;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: "pipe", maxBuffer: 64 * 1024 * 1024 }).trim();
}

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const posix = (p) => p.split(path.sep).join("/");

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function split(file) {
  return parseInt(sha(posix(file)).slice(0, 8), 16) % 100 < HELD_OUT_PERCENT ? "heldout" : "train";
}

// One test file in its own node, results through reporter.js. Its memory
// dir is a temp one (as run_tests.js does), so nothing real is written.
function runTestFile(cwd, testFile, { timeoutMs, coverageDir } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mana-taskgen-"));
  const out = path.join(tmp, "results.jsonl");
  const env = { ...testEnv(process.env), MANA_ACP_MEMORY_DIR: path.join(tmp, "acp-memory") };
  if (coverageDir) env.NODE_V8_COVERAGE = coverageDir;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [`--test-reporter=${REPORTER}`, `--test-reporter-destination=${out}`, testFile], {
      cwd,
      env,
      windowsHide: true,
      stdio: "ignore",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    let finished = false;
    const done = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      let results = [];
      try {
        results = fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      } catch {}
      fs.rmSync(tmp, { recursive: true, force: true });
      resolve({ code, timedOut, ms: Date.now() - started, results });
    };
    child.on("error", () => done(-1));
    child.on("exit", done);
  });
}

const fullName = (r) => [...r.parents, r.name].join(" > ");

// What a run says about a mutant: survived, killed (with the failing tests),
// crash or timeout.
function judge(run) {
  if (run.timedOut) return { verdict: "timeout" };
  const failed = run.results.filter((r) => !r.passed && r.failureType !== "subtestsFailed");
  if (!failed.length) return { verdict: run.code === 0 ? "survived" : "crash" };
  if (failed.some((r) => r.failureType === "testTimeoutFailure")) return { verdict: "timeout" };
  if (failed.some((r) => r.code !== "ERR_ASSERTION")) return { verdict: "crash" };
  return { verdict: "killed", failing: failed.map((r) => ({ name: fullName(r), test: r.name, parents: r.parents, message: r.message })) };
}

// tests: [{ file, ms }] covering the mutated spot, whose baseline passed.
async function validateMutant(tests, runTest) {
  for (const t of [...tests].sort((a, b) => a.ms - b.ms)) {
    const run = await runTest(t);
    const j = judge(run);
    if (j.verdict !== "survived") return { ...j, test: t.file, ms: run.ms };
  }
  return { verdict: "survived" };
}

// node-bot sources each test file requires directly ("../x").
function requireGraph(nodeBot) {
  const testDir = path.join(nodeBot, "test");
  const graph = {};
  for (const f of fs.readdirSync(testDir).filter((x) => x.endsWith(".test.js")).sort()) {
    const text = fs.readFileSync(path.join(testDir, f), "utf8");
    const sources = new Set();
    for (const m of text.matchAll(/require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
      let full;
      try {
        full = require.resolve(path.resolve(testDir, m[1]));
      } catch {
        continue;
      }
      const rel = posix(path.relative(nodeBot, full));
      if (rel.endsWith(".js") && !/^(\.\.|node_modules|test|bench)\//.test(rel)) sources.add(rel);
    }
    if (sources.size) graph[`test/${f}`] = [...sources].sort();
  }
  return graph;
}

// V8 coverage of one run, for the given sources: { rel: { blocks, fns } },
// blocks as [start, end, count] and fns as [start, end, name].
function readCoverage(coverageDir, nodeBot, wanted) {
  const out = {};
  const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  const want = new Map(wanted.map((rel) => [norm(path.join(nodeBot, rel)), rel]));
  for (const f of fs.existsSync(coverageDir) ? fs.readdirSync(coverageDir) : []) {
    const { result = [] } = JSON.parse(fs.readFileSync(path.join(coverageDir, f), "utf8"));
    for (const script of result) {
      if (!script.url.startsWith("file:")) continue;
      const rel = want.get(norm(fileURLToPath(script.url)));
      if (!rel) continue;
      const entry = (out[rel] ||= { blocks: [], fns: [] });
      for (const fn of script.functions) {
        const [whole] = fn.ranges;
        entry.fns.push([whole.startOffset, whole.endOffset, fn.functionName]);
        for (const r of fn.ranges) entry.blocks.push([r.startOffset, r.endOffset, r.count]);
      }
    }
  }
  return out;
}

// The innermost range around offset.
function innermost(ranges, offset) {
  let best = null;
  for (const r of ranges) if (r[0] <= offset && offset < r[1] && (!best || r[1] - r[0] < best[1] - best[0])) best = r;
  return best;
}

const isCovered = (cov, offset) => (innermost(cov.blocks, offset)?.[2] || 0) > 0;
function functionAt(cov, offset) {
  const fn = innermost(cov.fns, offset);
  return !fn || fn[0] === 0 ? "(module)" : fn[2] || `(anonymous@${fn[0]})`;
}

// Each test's baseline (it must pass) and coverage of its direct requires:
// { source: [{ test, ms, blocks, fns }] }.
async function coverageMap(nodeBot, { testTimeoutMs, gate, log }) {
  const map = {};
  for (const [test, sources] of Object.entries(requireGraph(nodeBot))) {
    await gate();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-taskgen-cov-"));
    try {
      const run = await runTestFile(nodeBot, test, { timeoutMs: testTimeoutMs, coverageDir: dir });
      const ok = !run.timedOut && run.code === 0 && run.results.some((r) => r.passed && !r.skipped);
      log(`baseline ${test}: ${ok ? "pass" : "FAIL (left out)"} in ${run.ms}ms`);
      if (!ok) continue;
      for (const [rel, cov] of Object.entries(readCoverage(dir, nodeBot, sources))) (map[rel] ||= []).push({ test, ms: run.ms, ...cov });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return map;
}

// The file's opening comment, as one line of prose: its first sentence,
// without issue numbers or file names.
function purpose(src) {
  const m = /^(?:#!.*\r?\n)?\s*((?:\/\/.*\r?\n\s*)+|\/\*[\s\S]*?\*\/)/.exec(src);
  if (!m) return "";
  let s = m[1]
    .replace(/^\s*(?:\/\/+|\/\*+|\*+\/?)/gm, " ")
    .replace(/\((?:[^()]*?)#\d+[^()]*\)/g, "")
    .replace(/(?:\b(?:issues?|PRs?)\s*)?#\d+:?|\(Q\d+[a-z]?\):?/gi, "")
    .replace(/[\w./\\-]+\.(?:js|json|ts|py|cs|md)\b/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s:;,.-]+/, "")
    .trim();
  s = (/^.*?[.!?](?=\s|$)/.exec(s) || [s])[0];
  if (s.length > 240) s = `${s.slice(0, 240).replace(/\s+\S*$/, "")}...`;
  return s.length < 12 ? "" : s[0].toUpperCase() + s.slice(1);
}

function scrub(text, paths) {
  let s = String(text || "");
  for (const p of paths) for (const v of [p, posix(p), p.replace(/\\/g, "\\\\")]) s = s.split(v).join("<dir>");
  const lines = s.trim().split(/\r?\n/);
  return (lines.length > 25 ? [...lines.slice(0, 25), "..."] : lines).join("\n").slice(0, 1500);
}

const TITLES = [(n) => `"${n}" fails`, (n) => `Broken: ${n}`, (n) => `Regression: ${n}`];
const LEADS = [
  "Something's off here. I expected this to hold, and it doesn't:",
  "This used to work and doesn't now:",
  "I'm getting the wrong result here. What I expect:",
];

// The issue a person would file: what they expected (the failing test's
// name), what they got (its assertion message) and the area (the
// module's purpose). Never the file, line or function to fix.
function writeIssue({ id, failing, area, scrubPaths = [] }) {
  const v = parseInt(sha(id).slice(0, 8), 16);
  const [first, ...rest] = failing;
  const { test: leaf, parents } = first;
  const title = TITLES[v % TITLES.length](leaf).slice(0, 120);
  const others = rest.slice(0, 3).map((f) => `- ${f.name}`);
  if (rest.length > 3) others.push(`- and ${rest.length - 3} more`);
  const body = [
    area ? `Area: ${area}` : "",
    `${LEADS[v % LEADS.length]} ${parents.length ? `${parents.join(" / ")}: ` : ""}${leaf}.`,
    `What I get instead:\n\n\`\`\`\n${scrub(first.message, scrubPaths)}\n\`\`\``,
    others.length ? `The same thing shows up in:\n${others.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return { title, body: `${body}\n` };
}

// Finding the spot is the hard part: a big file, a single failing test and
// the quieter operators make it harder.
function difficulty({ op, lines, failing }) {
  const score = (lines > 1000 ? 2 : lines > 300 ? 1 : 0) + (failing === 1 ? 1 : 0) + (["remove-await", "swap-args", "wrong-key"].includes(op) ? 1 : 0);
  return score <= 1 ? "easy" : score === 2 ? "medium" : "hard";
}

async function generate(opts) {
  const { repoRoot, worktreesDir, outDir = OUT_DIR, count = 200, seed = 1231, perFile = 6, budgetMs = 120 * 60000 } = opts;
  const testTimeoutMs = opts.testTimeoutMs || 60000;
  const log = opts.log || console.log;
  const ramPercent = opts.ramPercent || systemRamPercent;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const started = Date.now();
  const base = git(repoRoot, "rev-parse", opts.base || "HEAD");
  const gate = async () => {
    for (let waited = 0; ramPercent() > MAX_RAM_PERCENT; waited += 1) {
      if (waited >= 20) throw new Error(`RAM stayed above ${MAX_RAM_PERCENT}% for 20 minutes`);
      log(`RAM at ${ramPercent()}%, waiting a minute.`);
      await sleep(60000);
    }
  };

  const wt = path.join(worktreesDir, `taskgen-${base.slice(0, 8)}`);
  makeWorktree(repoRoot, wt, base);
  const nodeBot = path.join(wt, "node-bot");
  const casesDir = path.join(outDir, "cases");
  fs.mkdirSync(casesDir, { recursive: true });
  const stats = Object.fromEntries(Object.keys(OPERATORS).map((op) => [op, { tried: 0, kept: 0, survived: 0, crash: 0, timeout: 0, uncompilable: 0 }]));
  const validateMs = [];
  let kept = 0;
  try {
    const cacheFile = path.join(outDir, `coverage-${base.slice(0, 12)}.json`);
    let map;
    if (fs.existsSync(cacheFile)) map = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    else {
      map = await coverageMap(nodeBot, { testTimeoutMs, gate, log });
      fs.writeFileSync(cacheFile, JSON.stringify(map));
    }

    // Candidate spots, grouped by file, function and operator.
    const groups = new Map();
    const sources = {};
    for (const file of Object.keys(map).sort()) {
      const src = (sources[file] = fs.readFileSync(path.join(nodeBot, file), "utf8"));
      for (const e of edits(src)) {
        const covering = map[file].filter((c) => isCovered(c, e.start));
        if (!covering.length) continue;
        const tests = covering.map(({ test, ms }) => ({ file: test, ms }));
        const key = `${file}|${functionAt(covering[0], e.start)}|${e.op}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ file, edit: e, tests });
      }
    }
    // Operators taken in turn, so the batch is balanced from the start.
    const rand = rng(seed);
    const byOp = Object.keys(OPERATORS).map((op) => shuffle([...groups.keys()].filter((k) => k.endsWith(`|${op}`)), rand));
    const order = [];
    for (let i = 0; byOp.some((l) => i < l.length); i += 1) for (const l of byOp) if (i < l.length) order.push(l[i]);
    log(`${groups.size} function/operator pairs over ${Object.keys(map).length} covered files.`);

    const perFileKept = {};
    for (const key of order) {
      if (kept >= count || Date.now() - started > budgetMs) break;
      const sites = shuffle([...groups.get(key)], rand).slice(0, TRIES_PER_KEY);
      const { file } = sites[0];
      if ((perFileKept[file] || 0) >= perFile) continue;
      for (const { edit, tests } of sites) {
        const s = stats[edit.op];
        const original = sources[file];
        const mutated = mutant(original, edit);
        if (!mutated) {
          s.uncompilable += 1;
          continue;
        }
        s.tried += 1;
        const full = path.join(nodeBot, file);
        const t0 = Date.now();
        let result;
        let patch = "";
        fs.writeFileSync(full, mutated);
        try {
          result = await validateMutant(tests, async (t) => {
            await gate();
            return runTestFile(nodeBot, t.file, { timeoutMs: Math.min(testTimeoutMs, Math.max(15000, 3 * t.ms + 5000)) });
          });
          // Untrimmed: a blank context line at the end is a lone space.
          if (result.verdict === "killed") {
            patch = execFileSync("git", ["diff", "--no-color", "--", `node-bot/${file}`], { cwd: wt, encoding: "utf8", windowsHide: true });
          }
        } finally {
          fs.writeFileSync(full, original);
        }
        validateMs.push(Date.now() - t0);
        s[result.verdict === "killed" ? "kept" : result.verdict] += 1;
        if (result.verdict !== "killed") continue;

        const hash = sha(`${file}|${edit.op}|${edit.start}|${edit.text}`).slice(0, 8);
        const id = `gen-${edit.op}-${file.replace(/\.js$/, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${hash}`;
        const issue = writeIssue({ id, failing: result.failing, area: purpose(original), scrubPaths: [wt, os.tmpdir()] });
        const c = {
          id,
          // A made-up number in a range real issues won't reach; her prompt names it.
          issue: 900000 + (parseInt(hash, 16) % 100000),
          base,
          // The fix is the base's own file: verifyCase checks it out.
          fix: base,
          title: issue.title,
          body: issue.body,
          fixFiles: [`node-bot/${file}`],
          hiddenTests: [`node-bot/${result.test}`],
          testCommand: `node --test ${result.test}`,
          mutation: patch,
          kind: "mutation",
          operator: edit.op,
          difficulty: difficulty({ op: edit.op, lines: original.split("\n").length, failing: result.failing.length }),
          split: split(`node-bot/${file}`),
          why: `Generated: ${edit.note} in ${key.split("|")[1]}.`,
          failingTests: result.failing.map((f) => ({ name: f.name, message: scrub(f.message, [wt, os.tmpdir()]) })),
          validateMs: result.ms,
        };
        fs.writeFileSync(path.join(casesDir, `${id}.json`), `${JSON.stringify(c, null, 2)}\n`);
        kept += 1;
        perFileKept[file] = (perFileKept[file] || 0) + 1;
        log(`kept ${kept}/${count}: ${id}`);
        break;
      }
    }
  } finally {
    removeWorktree(repoRoot, wt);
    const summary = {
      base,
      seed,
      kept,
      minutes: Math.round((Date.now() - started) / 600) / 100,
      avgValidateMs: validateMs.length ? Math.round(validateMs.reduce((a, b) => a + b, 0) / validateMs.length) : 0,
      byOperator: stats,
    };
    fs.writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    log(JSON.stringify(summary, null, 2));
  }
}

async function main(argv) {
  try {
    os.setPriority(0, 10);
  } catch {}
  const opt = (name, fallback) => {
    const i = argv.indexOf(name);
    return i < 0 ? fallback : argv[i + 1];
  };
  const repoRoot = path.dirname(git(__dirname, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  await generate({
    repoRoot,
    worktreesDir: path.join(path.dirname(repoRoot), "Mana-worktrees"),
    // HEAD of the checkout this runs from, so a worktree's own branch works.
    base: opt("--base", git(__dirname, "rev-parse", "HEAD")),
    outDir: path.resolve(opt("--out", OUT_DIR)),
    count: Number(opt("--count", 200)),
    seed: Number(opt("--seed", 1231)),
    perFile: Number(opt("--per-file", 6)),
    budgetMs: Number(opt("--budget-min", 120)) * 60000,
    testTimeoutMs: Number(opt("--test-timeout-s", 60)) * 1000,
  });
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.stack || e.message);
    process.exitCode = 1;
  });
}

module.exports = { judge, validateMutant, writeIssue, purpose, split, difficulty, requireGraph, runTestFile, rng, shuffle };
