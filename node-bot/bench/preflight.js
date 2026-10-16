// #1467: everything the bench needs, checked before any GPU time is spent,
// so a run measures the model and not the harness. Each check returns a
// problem (a string) or null; the bench stops on any problem.
//   - the sandbox copy-source approval exists, parses, and covers the
//     node_modules her worktrees link to (her tests fail without it);
//   - the sandbox's helper is there (it's built, not in git);
//   - a sandboxed test really runs in a bench worktree, through the link;
//   - the model file and --server-args flags exist;
//   - every case is sound: its hidden tests fail at the base and pass with
//     the fix (cached per case), and its fix touches none of her guardrails
//     (she can't change those herself); others are left out, with why;
//   - once the model is up, it makes a tool call the loop can parse.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const VERIFIED_FILE = path.join(__dirname, "results", "verified-cases.json");

function copySourcesProblem(repoRoot, { load = () => require("../tools/native-execution").approvedCopySources() } = {}) {
  const modules = path.join(repoRoot, "node-bot", "node_modules");
  if (!fs.existsSync(modules)) return null;
  const where = path.join(__dirname, "..", "data", "native-sandbox-copy-sources.json");
  let sources;
  try {
    sources = load();
  } catch (e) {
    return `${where} is invalid (${e.message}); her sandboxed tests would all fail`;
  }
  const real = fs.realpathSync(modules).toLowerCase();
  const covered = sources.dependencyRoots.some((root) => {
    const r = (fs.existsSync(root) ? fs.realpathSync(root) : root).toLowerCase();
    return real === r || real.startsWith(r + path.sep);
  });
  return covered ? null : `${where} doesn't approve ${modules} (her worktrees link to it), so her sandboxed tests would fail with "Copy would leave the approved source"`;
}

// The sandbox's helper is built, not in git: a worktree the bench runs from
// has none unless it's copied or built there.
function helperProblem({ helper = require("../tools/analysis-sandbox").HELPER_PATH, platform = process.platform } = {}) {
  if (platform !== "win32" || fs.existsSync(helper)) return null;
  return `the sandbox helper ${helper} is missing (it's built, not in git), so every test she runs would fail; copy tools/analysis-sandbox/bundle from the main checkout or build it`;
}

// Every module the node-bot's own code requires from a package (sub-paths
// included), so the check loads what she loads, not just each package's
// main entry. A package she never requires isn't checked.
function usedSpecifiers(nodeBot, deps) {
  const found = new Set();
  if (!fs.existsSync(nodeBot)) return [];
  const visit = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) visit(full);
      else if (/\.[cm]?js$/.test(name)) {
        for (const m of fs.readFileSync(full, "utf8").matchAll(/require\(\s*["']([^"'./][^"']*)["']\s*\)/g)) {
          const spec = m[1];
          const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
          if (deps.includes(pkg)) found.add(spec);
        }
      }
    }
  };
  visit(nodeBot);
  return [...found].sort();
}

// A throwaway test that loads every package module she uses through the
// worktree's node_modules link, run exactly as her test runs are (the
// sandbox, a disposable copy). Any that doesn't load is named.
async function sandboxProblem(wt, { run = require("../tools/native-execution").runSandboxedTestCommand, copySources, specifiers } = {}) {
  const nodeBot = path.join(wt, "node-bot");
  const pkgFile = path.join(nodeBot, "package.json");
  const deps = fs.existsSync(pkgFile) ? Object.keys(JSON.parse(fs.readFileSync(pkgFile, "utf8")).dependencies || {}) : [];
  const specs = specifiers || usedSpecifiers(nodeBot, deps);
  const rel = path.join("test", "bench-preflight.test.js");
  const file = path.join(nodeBot, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'const test = require("node:test");\n' + specs.map((s) => `test(${JSON.stringify(s)}, () => { require(${JSON.stringify(s)}); });`).join("\n") + "\n");
  try {
    const sources = copySources || require("../tools/native-execution").approvedCopySources();
    const r = await run(`node --test ${rel.replace(/\\/g, "/")}`, nodeBot, { copySources: sources, workspaceRoot: wt });
    if (r?.exitCode === 0) return null;
    const output = String(r?.output || "");
    const missing = [...output.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
    const which = missing.length ? `; these don't load: ${missing.join(", ")}` : "";
    return `a sandboxed test in a bench worktree failed (exit ${r?.exitCode}${r?.timedOut ? ", timed out" : ""}): ${output.slice(-300)}${which}`;
  } catch (e) {
    return `a sandboxed test in a bench worktree couldn't run: ${e.message}`;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// Flags in --server-args that this llama-server doesn't know.
function serverArgsProblem(serverArgs, bin, { help = () => execFileSync(bin, ["--help"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) } = {}) {
  const flags = String(serverArgs || "").split(/[\s,]+/).filter((a) => /^-{1,2}[a-z]/i.test(a));
  if (!flags.length) return null;
  let text;
  try {
    text = help();
  } catch (e) {
    text = `${e.stdout || ""}${e.stderr || ""}`;
  }
  const unknown = flags.filter((f) => !new RegExp(`(^|[\\s,])${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([\\s,=]|$)`, "m").test(text));
  return unknown.length ? `${path.basename(bin)} doesn't know ${unknown.join(", ")} (from --server-args)` : null;
}

// The harness's own code: a change to how tests run (the sandbox, the copy, the guard, the bench) can change a
// case's verdict, so every case is checked again after one.
const HARNESS_FILES = [
  path.join(__dirname, "..", "tools", "native-execution.js"),
  path.join(__dirname, "..", "self-work.js"),
  path.join(__dirname, "..", "protected-paths.js"),
  path.join(__dirname, "self-work-bench.js"),
  path.join(__dirname, "preflight.js"),
];
function harnessFingerprint(files = HARNESS_FILES) {
  const h = crypto.createHash("sha256");
  for (const f of files) if (fs.existsSync(f)) h.update(fs.readFileSync(f));
  return h.digest("hex");
}

// What a case's verdict depends on: the case, its hidden tests, Node, and the harness that runs it.
function caseKey(c) {
  // Only what the verdict depends on: the wording, interface and budgets can change without a new check.
  const { id, base, fix, fixFiles, hiddenTests, testCommand, mutation } = c;
  const h = crypto.createHash("sha256").update(JSON.stringify({ id, base, fix, fixFiles, hiddenTests, testCommand, mutation })).update(process.version).update(harnessFingerprint());
  if (c.hiddenFrom) for (const rel of c.hiddenTests || []) h.update(fs.readFileSync(path.join(c.hiddenFrom, rel)));
  return h.digest("hex");
}

// Sound cases, and the ones left out with why. verify(c) is the bench's
// verifyCase; verdicts are cached so a case is checked once.
// guarded(c): why the case can't be hers to do (its fix changes one of her guardrails), or null.
async function soundCases(cases, verify, { file = VERIFIED_FILE, log = console.log, guarded = () => null } = {}) {
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  const sound = [];
  const skipped = [];
  for (const c of cases) {
    const why = guarded(c);
    if (why) {
      skipped.push({ id: c.id, why });
      continue;
    }
    const key = caseKey(c);
    let v = cache[c.id]?.key === key ? cache[c.id] : null;
    if (!v) {
      log(`Checking case ${c.id}...`);
      const r = await verify(c);
      v = { key, ok: r.ok, failsAtBase: r.failsAtBase, passesWithFix: r.passesWithFix };
      cache[c.id] = v;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(cache, null, 2));
    }
    if (v.ok) sound.push(c);
    else skipped.push({ id: c.id, why: !v.failsAtBase ? "its hidden tests already pass at the base (a free pass)" : "its hidden tests don't pass with the fix" });
  }
  return { sound, skipped };
}

// The model, once up, makes one tool call the loop parses and runs.
async function toolCallProblem(runLoop) {
  let called = false;
  const policy = {
    tools: [{ type: "function", function: { name: "bench_ping", description: "Answer a ping.", parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] } } }],
    executeTool: async (name) => {
      if (name === "bench_ping") called = true;
      return "pong";
    },
  };
  try {
    await runLoop('Call the bench_ping tool with {"n": 1}, then say "done".', policy, { maxRounds: 3, maxTokens: 256 });
  } catch (e) {
    return `the model's first tool call failed: ${e.message}`;
  }
  return called ? null : "the model didn't make a tool call the loop could parse";
}

module.exports = { copySourcesProblem, helperProblem, sandboxProblem, serverArgsProblem, soundCases, toolCallProblem, caseKey, harnessFingerprint, usedSpecifiers, VERIFIED_FILE };
