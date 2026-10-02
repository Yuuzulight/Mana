// #1269: Gemini CLI as self-work's cloud fallback. When every local attempt
// at an issue failed, the official CLI runs headless in her worktree on my
// own sign-in (its cached one: Mana starts the CLI and never reads its
// credentials). Its tools are cut to reading, searching and editing files:
// no shell (a test file it writes is arbitrary code, so "only the tests"
// isn't a real limit), no web, no MCP, no git. self-work.js then checks its
// diff, runs the tests and reviews it as her own.
//
// Settings, in node-bot/.env beside her other MANA_SELF_WORK_* ones:
//   MANA_SELF_WORK_GEMINI=0|1        off / on; unset: on when the CLI is found and signed in
//   MANA_SELF_WORK_GEMINI_MODEL      a model for -m; unset: the CLI's own default
//   MANA_SELF_WORK_GEMINI_PER_ISSUE  runs per issue (default 1)
//   MANA_SELF_WORK_GEMINI_PER_DAY    runs per day (default 5)
//   MANA_SELF_WORK_GEMINI_CLI        the command (default gemini)
// Each run is logged (when, issue, duration, outcome, model; never its
// output) in self-work-gemini.json beside her worktrees, which the caps
// count from.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { killProcessTree } = require("./utils/kill-process-tree");
const { testEnv } = require("./ai/git-tool-source");
const { isLocalOnly } = require("./local-only");

const INSTALL_HINT = "Install it with npm install -g @google/gemini-cli, then run gemini once and choose Sign in with Google.";
// Read, search and edit; everything else (shell, web, memory, MCP, skills,
// subagents) is denied by an admin-tier policy.
const TOOLS = ["read_file", "read_many_files", "list_directory", "glob", "grep_search", "replace", "write_file", "write_todos"];
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
const VERSION_TIMEOUT_MS = 30 * 1000;
const MAX_TURNS = 100;
const MAX_OUTPUT = 4 * 1024 * 1024;
const DETECT_TTL_MS = 5 * 60 * 1000;
const MAX_LEDGER = 500;
const QUOTA_RE = /\b429\b|RESOURCE_EXHAUSTED|quota|rate.?limit/i;
// What it needs to find its sign-in; nothing else of the backend's.
const AUTH_KEYS = ["HOME", "GEMINI_CLI_HOME", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS"];
const API_KEYS = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI"];

const POLICY = `[[rule]]
toolName = ${JSON.stringify(TOOLS)}
decision = "allow"
priority = 999

[[rule]]
toolName = "*"
decision = "deny"
priority = 1
denyMessage = "Here you can only read, search and edit files in this folder."
`;

const count = (value, fallback) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const localDay = (d) => d.toLocaleDateString("sv");

function createGeminiFallback({ env = process.env, ledgerFile, spawnImpl = spawn, now = () => new Date(), home = os.homedir() } = {}) {
  const bin = env.MANA_SELF_WORK_GEMINI_CLI || "gemini";
  const setting = String(env.MANA_SELF_WORK_GEMINI ?? "").trim().toLowerCase();
  const off = /^(0|off|false|no)$/.test(setting);
  const model = String(env.MANA_SELF_WORK_GEMINI_MODEL || "").trim();
  // It goes on a command line: a name, nothing else.
  const badModel = Boolean(model) && !/^[\w.-]+$/.test(model);
  const perIssue = count(env.MANA_SELF_WORK_GEMINI_PER_ISSUE, 1);
  const perDay = count(env.MANA_SELF_WORK_GEMINI_PER_DAY, 5);

  function childEnv(extra) {
    const { NODE_ENV, DOTNET_CLI_TELEMETRY_OPTOUT, ...base } = testEnv(env);
    for (const k of AUTH_KEYS) if (env[k]) base[k] = env[k];
    return { ...base, ...extra };
  }

  // A .js is run with node (the tests' fake); a command goes through the
  // shell on Windows, where an npm install is gemini.cmd. Every argument is
  // fixed or a checked model name, and the prompt goes in on stdin.
  function exec(args, { cwd, input = "", timeoutMs, extraEnv = {} }) {
    const started = Date.now();
    return new Promise((resolve) => {
      const opts = { cwd, env: childEnv(extraEnv), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] };
      let child;
      try {
        child = /\.[cm]?js$/i.test(bin)
          ? spawnImpl(process.execPath, [bin, ...args], opts)
          : process.platform === "win32"
            ? spawnImpl([/\s/.test(bin) ? `"${bin}"` : bin, ...args].join(" "), { ...opts, shell: true })
            : spawnImpl(bin, args, opts);
      } catch (e) {
        return resolve({ code: -1, stdout: "", stderr: e.message, missing: true, ms: 0 });
      }
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, timeoutMs);
      child.stdout.on("data", (d) => {
        if (stdout.length < MAX_OUTPUT) stdout += d;
      });
      child.stderr.on("data", (d) => {
        if (stderr.length < MAX_OUTPUT) stderr += d;
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: e.message, missing: e.code === "ENOENT", ms: Date.now() - started });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr, timedOut, ms: Date.now() - started });
      });
    });
  }

  // Signed in: an API key in the environment, or the auth type the CLI
  // saves in its settings at sign-in. Its credential files are never read.
  function signedIn() {
    if (API_KEYS.some((k) => env[k])) return true;
    try {
      const text = fs.readFileSync(path.join(env.GEMINI_CLI_HOME || home, ".gemini", "settings.json"), "utf8");
      return /"(selectedType|selectedAuthType)"\s*:\s*"[^"]+"/.test(text);
    } catch {
      return false;
    }
  }

  let detected = null;
  let detectedAt = 0;
  let last = null;
  function detect() {
    if (!detected || Date.now() - detectedAt > DETECT_TTL_MS) {
      detectedAt = Date.now();
      detected = exec(["--version"], { timeoutMs: VERSION_TIMEOUT_MS }).then((r) => {
        // On Windows a missing command is the shell's exit 1 ("not recognized").
        const installed = r.code === 0;
        const version = installed ? r.stdout.trim().split(/\r?\n/).pop() : null;
        return { installed, version, signedIn: installed && signedIn() };
      });
    }
    return detected;
  }

  function ledger() {
    try {
      const runs = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
      return Array.isArray(runs) ? runs : [];
    } catch {
      return [];
    }
  }
  function record(entry) {
    if (!ledgerFile) return;
    try {
      fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
      fs.writeFileSync(ledgerFile, JSON.stringify([...ledger(), entry].slice(-MAX_LEDGER), null, 2));
    } catch {}
  }

  // Everything GET /self-work shows, with why it's unavailable.
  async function state() {
    const d = await detect();
    const today = ledger().filter((e) => e.day === localDay(now())).length;
    const settingOff = off || badModel || isLocalOnly(env);
    const why = off
      ? "turned off (MANA_SELF_WORK_GEMINI=0)"
      : badModel
        ? "MANA_SELF_WORK_GEMINI_MODEL isn't a model name"
        : isLocalOnly(env)
          ? "local-only mode is on, and it would send my code to Google"
          : !d.installed
            ? `Gemini CLI isn't installed. ${INSTALL_HINT}`
            : !d.signedIn
              ? "Gemini CLI isn't signed in: run gemini once and choose Sign in with Google."
              : null;
    last = { enabled: !why, installed: d.installed, signedIn: d.signedIn, version: d.version, model: model || "the CLI's default", perIssue, perDay, usedToday: today, why };
    last.text = why
      ? `Gemini fallback: ${settingOff ? "off" : "unavailable"} -- ${why}`
      : `Gemini fallback: on (Gemini CLI ${d.version}, ${last.model}; ${today} of ${perDay} runs used today, ${perIssue} per issue).`;
    return last;
  }
  // The last state known, without waiting (and a fresh check started).
  function info() {
    state().catch(() => {});
    return last || { enabled: false, text: "Gemini fallback: checking..." };
  }

  // Why it shouldn't run for this issue now, or null.
  async function blocked(issue) {
    const s = await state();
    if (!s.enabled) return s.why;
    const runs = ledger();
    const today = runs.filter((e) => e.day === localDay(now()));
    if (today.some((e) => e.outcome === "quota")) return "Gemini CLI ran out of quota today, so I'm not asking it again until tomorrow.";
    if (today.length >= perDay) return `I've used Gemini CLI ${today.length} times today (the cap is ${perDay}).`;
    const mine = runs.filter((e) => e.issue === issue).length;
    if (mine >= perIssue) return `I've already asked Gemini CLI about #${issue} (the cap is ${perIssue} per issue).`;
    return null;
  }

  // One headless run in worktree. outcome: ok, quota, turn-limit, timeout,
  // missing or error. Settings and policy go in a system settings file of
  // its own (it overrides my user and the repo's project settings).
  async function run({ worktree, prompt, issue, log = true }) {
    if (badModel) throw new Error("MANA_SELF_WORK_GEMINI_MODEL isn't a model name");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-gemini-"));
    let r;
    try {
      const policy = path.join(dir, "policy.toml");
      fs.writeFileSync(policy, POLICY);
      const settings = path.join(dir, "settings.json");
      fs.writeFileSync(
        settings,
        JSON.stringify({
          adminPolicyPaths: [policy],
          tools: { core: TOOLS },
          admin: { extensions: { enabled: false }, mcp: { enabled: false }, skills: { enabled: false } },
          hooksConfig: { enabled: false },
          context: { includeDirectories: [] },
          model: { maxSessionTurns: MAX_TURNS },
          general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
        }),
      );
      const args = ["--output-format", "json", "--approval-mode", "auto_edit", "-e", "none", ...(model ? ["-m", model] : [])];
      r = await exec(args, {
        cwd: worktree,
        input: prompt,
        timeoutMs: RUN_TIMEOUT_MS,
        // Its trust prompt can't show headless; this folder is her worktree.
        extraEnv: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings, GEMINI_CLI_TRUST_WORKSPACE: "true" },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    let json = null;
    try {
      json = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    } catch {}
    const error = json?.error ? String(json.error.message || JSON.stringify(json.error)) : r.code !== 0 ? `${r.stderr}\n${r.stdout}`.trim() : "";
    const outcome = r.timedOut
      ? "timeout"
      : r.missing
        ? "missing"
        : r.code === 0 && !json?.error
          ? "ok"
          : QUOTA_RE.test(error)
            ? "quota"
            : r.code === 53
              ? "turn-limit"
              : "error";
    if (log) record({ at: now().toISOString(), day: localDay(now()), issue, ms: r.ms, outcome, model: model || "default" });
    return { outcome, ms: r.ms, code: r.code, response: String(json?.response || "").slice(0, 4000), error: error.slice(0, 300) };
  }

  return { state, info, blocked, run, model: model || "default" };
}

module.exports = { createGeminiFallback, INSTALL_HINT, TOOLS, POLICY };
