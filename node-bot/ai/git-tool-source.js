// #1182: git and GitHub for Mana, on par with what Claude Code does for me,
// with my approval where it matters. #1190: the reads, which never ask.
//
// Only real git repos under D:\Mana, D:\GitHub Projects\Folio, or one I
// approved when she asked (a "git-repo:<path>" approval, remembered like
// the browser's per-site ones); worktrees of those count. git and gh run
// from an argument array, never a shell, each with a timeout and an output
// cap, and refs and paths are checked first, so nothing she passes becomes
// a flag. gh uses my existing login; she never reads or prints a token.
// GitHub text (issues, PRs, comments, CI logs) and commits by someone else
// come back in the untrusted-content frame, which taints the turn
// (ai/tool-risk.js).
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { resolveWithinRoot, isCredentialPath } = require("./tool-policy");
const { wrapUntrusted } = require("./untrusted-content");

const GIT_READ_TOOL = "git__read";
const GITHUB_READ_TOOL = "github__read";
const DEFAULT_ROOTS = [path.join(__dirname, "..", ".."), "D:\\GitHub Projects\\Folio"];
const REPO_ACTION_TYPE = "git-repo";
const TIMEOUT_MS = 30 * 1000;
const NETWORK_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_BUFFER = 4 * 1024 * 1024;
const MAX_OUTPUT = 12000;
// origin/main, HEAD~2, v1.0, a sha, main..feature -- never a leading dash.
const REF_RE = /^\w[\w./~^@{}-]{0,199}$/;
// Every git call: a repo's own config can't start a program on a read.
const GIT_BASE = ["-c", "core.fsmonitor=false"];

// What git hooks and tests run with: a clean environment, not the
// backend's keys and tokens.
const CLEAN_ENV_KEYS = new Set(
  [
    "PATH", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "TEMP", "TMP", "USERPROFILE",
    "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
    "ProgramData", "CommonProgramFiles", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "DOTNET_ROOT",
  ].map((k) => k.toLowerCase()),
);
function testEnv(env) {
  const clean = Object.fromEntries(Object.entries(env).filter(([k]) => CLEAN_ENV_KEYS.has(k.toLowerCase())));
  return { ...clean, NODE_ENV: "test", DOTNET_CLI_TELEMETRY_OPTOUT: "1" };
}

// Secret shapes, and the backend's own secret values, in the lines a diff adds.
const SECRET_SHAPE_RE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{20,}|sk-[\w-]{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{35}|hf_[A-Za-z0-9]{30,}|glpat-[\w-]{20,})/;
function findSecret(diff, env) {
  const added = String(diff)
    .split(/\r?\n/)
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .join("\n");
  if (SECRET_SHAPE_RE.test(added)) return "a key-shaped string";
  const hit = Object.entries(env).find(
    ([k, v]) => /key|token|secret|password|passwd/i.test(k) && typeof v === "string" && v.length >= 12 && added.includes(v),
  );
  return hit ? `the value of ${hit[0]}` : null;
}

// Lines that would credit someone else with the change -- never in her commits or PRs.
function stripAttribution(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((l) => !/^\s*(co-authored-by|signed-off-by)\s*:|generated (with|by)\b/i.test(l))
    .join("\n")
    .trim();
}

// ponytail: a timeout kills git/gh itself, not a hook's children; a hook
// that hangs past it leaves its own processes behind.
function runCommand(cmd, args, { cwd, env, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, env, windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      // Past the buffer: keep what came, it's capped below anyway.
      const full = err?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      const timedOut = Boolean(err?.killed) && !full;
      const code = !err || full ? 0 : typeof err.code === "number" ? err.code : 1;
      const why = timedOut ? `timed out after ${timeoutMs / 1000}s` : err && !full ? err.message : "";
      resolve({ code, stdout: String(stdout || ""), stderr: String(stderr || "") || why, timedOut });
    });
  });
}

function cap(text, max = MAX_OUTPUT) {
  const s = String(text);
  return s.length > max ? `${s.slice(0, max)}\n...[cut at ${max} of ${s.length} characters]` : s;
}

function tail(text, max = MAX_OUTPUT) {
  const s = String(text);
  return s.length > max ? `[...the first ${s.length - max} characters cut]\n${s.slice(-max)}` : s;
}

function checkRef(ref) {
  if (!REF_RE.test(String(ref))) throw new Error(`"${ref}" isn't a ref I can use`);
  return String(ref);
}

function positiveInt(value, what) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${what} must be a positive number`);
  return String(n);
}

const within = (outer, inner) => {
  const rel = path.relative(outer, inner);
  return !rel || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

const REPO_PARAM = {
  type: "string",
  description: "The repo's folder. Default: your own code (D:\\Mana). Also D:\\GitHub Projects\\Folio, or a repo the user lets you use.",
};
const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: GIT_READ_TOOL,
      description: "Read a git repo: status, diff (capped), log, show a commit, or list branches. Changes nothing.",
      parameters: {
        type: "object",
        properties: {
          repo: REPO_PARAM,
          action: { type: "string", enum: ["status", "diff", "log", "show", "branches"] },
          ref: { type: "string", description: "diff/log: a ref or range (origin/main, main..HEAD). show: the commit. Default HEAD." },
          path: { type: "string", description: "diff/log: only this file or folder." },
          staged: { type: "boolean", description: "diff: what's staged for the next commit." },
          count: { type: "integer", description: "log: how many commits (default 15, at most 50)." },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: GITHUB_READ_TOOL,
      description:
        "Read the repo on GitHub: list PRs or issues, view one PR or issue with its comments, a PR's checks, a CI run (with its failed log), or a PR's review comments. Changes nothing.",
      parameters: {
        type: "object",
        properties: {
          repo: REPO_PARAM,
          action: { type: "string", enum: ["pr_list", "issue_list", "pr", "issue", "checks", "run", "review_comments"] },
          number: { type: "integer", description: "The PR or issue number (pr, issue, checks, review_comments)." },
          run_id: { type: "string", description: "run: the CI run's id." },
          state: { type: "string", enum: ["open", "closed", "merged", "all"], description: "pr_list/issue_list. Default open." },
          failed_log: { type: "boolean", description: "run: include the failed jobs' log (its end)." },
        },
        required: ["action"],
      },
    },
  },
];
const TOOL_NAMES = new Set(TOOL_SCHEMAS.map((t) => t.function.name));

// options.roots: the folders whose repos she may use (default above).
// options.approvalGate: asks me about a repo outside them.
// options.exec/env: injectable for tests.
function createGitToolSource(options = {}) {
  const exec = options.exec || runCommand;
  const env = options.env || process.env;
  const approvalGate = options.approvalGate || null;
  const roots = (options.roots || DEFAULT_ROOTS).map((r) => path.resolve(r));
  const defaultRepo = roots[0];
  const gitEnv = { ...testEnv(env), GIT_TERMINAL_PROMPT: "0" };
  const ghEnv = { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };
  // "Allow once" on a repo lasts until Mana restarts.
  const onceRepos = new Set();

  async function run(cmd, args, cwd, timeoutMs, label = args[0]) {
    const r = await exec(cmd, args, { cwd, env: cmd === "git" ? gitEnv : ghEnv, timeoutMs });
    if (r.code !== 0) throw new Error(`${cmd} ${label} failed: ${cap((r.stderr || r.stdout).trim(), 500)}`);
    return r.stdout;
  }
  const git = (args, cwd, timeoutMs = TIMEOUT_MS) => run("git", [...GIT_BASE, ...args], cwd, timeoutMs, args[0]);
  const gh = (args, cwd) => run("gh", args, cwd, NETWORK_TIMEOUT_MS);

  // { top, main, key } for a repo she may use: top is the checkout (or
  // worktree) itself, main the repo that owns its .git.
  async function openRepo(repoArg) {
    const dir = path.resolve(String(repoArg || defaultRepo));
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${dir} isn't a folder`);
    const [top, common] = (await git(["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], dir))
      .trim()
      .split(/\r?\n/)
      .map((p) => path.resolve(p));
    const main = path.basename(common).toLowerCase() === ".git" ? path.dirname(common) : common;
    const key = `${REPO_ACTION_TYPE}:${main.replace(/\\/g, "/").toLowerCase()}`;
    const repo = { top, main, key };
    if (roots.some((root) => within(root, main)) || onceRepos.has(key) || approvalGate?.isGranted(key)) return repo;
    if (!approvalGate) throw new Error(`${main} isn't one of the repos I may use`);
    approvalGate.registerExecutor(key, async () => {
      onceRepos.add(key);
      return { approved: true };
    });
    const outcome = await approvalGate.requestApproval(key, {
      summary: `Let Mana use git and GitHub in ${main}`,
      payload: { repo: main },
    });
    if (outcome.status === "approved") return repo;
    throw new Error(
      outcome.status === "pending"
        ? `${main} isn't one of the repos I may use yet; that needs the user's OK first (request ${outcome.requestId}). Tell them, and try again once they allow it.`
        : `I may not use ${main}: ${outcome.reason || outcome.status}`,
    );
  }

  // A file or folder in the repo, as git's path after "--".
  function repoPath(top, rel) {
    const full = resolveWithinRoot(top, rel);
    if (isCredentialPath(path.basename(full))) throw new Error("refusing a credential file");
    return path.relative(top, full).split(path.sep).join("/") || ".";
  }

  // Framed as untrusted when anyone but the repo's own user wrote it.
  async function byOthers(top, authors) {
    const me = (await exec("git", [...GIT_BASE, "config", "user.name"], { cwd: top, env: gitEnv })).stdout.trim();
    return authors.some((a) => a !== me);
  }

  async function gitRead({ repo, action, ref, path: rel, staged, count }) {
    const { top } = await openRepo(repo);
    const refArg = ref ? [checkRef(ref)] : [];
    const pathArg = rel ? ["--", repoPath(top, rel)] : [];
    const head = `git ${action} in ${top}:`;
    if (action === "status") return `${head}\n${cap(await git(["status", "--short", "--branch"], top))}`;
    if (action === "branches") {
      const format = "--format=%(HEAD) %(refname:short) %(upstream:short) %(upstream:track)";
      return `${head}\n${cap(await git(["branch", "--all", "--no-color", format], top))}`;
    }
    if (action === "diff") {
      const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--stat", "--patch", ...(staged ? ["--cached"] : [])];
      const text = await git([...args, ...refArg, ...pathArg], top);
      return `${head}\n${cap(text) || "(no changes)"}`;
    }
    if (action === "log") {
      const n = Math.min(50, Math.max(1, Number(count) || 15));
      const lines = (await git(["log", "--no-color", `-n${n}`, "--date=short", "--format=%h%x09%ad%x09%an%x09%s", ...refArg, ...pathArg], top))
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => l.split("\t"));
      const text = cap(lines.map(([h, d, a, s]) => `${h} ${d} ${a}: ${s}`).join("\n"));
      return (await byOthers(top, lines.map((l) => l[2]))) ? `${head}\n${wrapUntrusted("git history", text)}` : `${head}\n${text}`;
    }
    if (action === "show") {
      const commit = checkRef(ref || "HEAD");
      const author = (await git(["log", "-1", "--format=%an", commit], top)).trim();
      const text = cap(await git(["show", "--no-color", "--no-ext-diff", "--no-textconv", "--stat", "--patch", "--format=fuller", commit], top));
      return (await byOthers(top, [author])) ? `${head}\n${wrapUntrusted("git history", text)}` : `${head}\n${text}`;
    }
    throw new Error(`unknown action: ${action}`);
  }

  const who = (u) => u?.login || "someone";
  const said = (items, max) =>
    (items || []).slice(-max).map((c) => `- ${who(c.author)}${c.state ? ` (${c.state})` : ""}: ${cap(String(c.body || "").trim(), 1000)}`);

  async function githubRead({ repo, action, number, run_id: runId, state, failed_log: failedLog }) {
    const { top } = await openRepo(repo);
    const head = `GitHub ${action}${number ? ` #${number}` : ""} for ${top}:`;
    const framed = (text) => `${head}\n${wrapUntrusted("GitHub", cap(text))}`;
    if (action === "pr_list" || action === "issue_list") {
      const kind = action === "pr_list" ? "pr" : "issue";
      const allowed = kind === "pr" ? ["open", "closed", "merged", "all"] : ["open", "closed", "all"];
      const st = allowed.includes(state) ? state : "open";
      const fields = kind === "pr" ? "number,title,author,headRefName,isDraft" : "number,title,author,labels";
      const items = JSON.parse(await gh([kind, "list", "--state", st, "--limit", "30", "--json", fields], top));
      if (!items.length) return `${head}\nNone (${st}).`;
      return framed(
        items
          .map((i) => `#${i.number} ${i.title} (by ${who(i.author)}${i.headRefName ? `, ${i.headRefName}` : ""}${i.isDraft ? ", draft" : ""}${i.labels?.length ? `, labels: ${i.labels.map((l) => l.name).join(", ")}` : ""})`)
          .join("\n"),
      );
    }
    if (action === "pr") {
      const fields = "number,title,state,isDraft,author,headRefName,baseRefName,mergeable,reviewDecision,url,body,reviews,comments";
      const p = JSON.parse(await gh(["pr", "view", positiveInt(number, "number"), "--json", fields], top));
      return framed(
        [
          `PR #${p.number}: ${p.title} (${p.state}${p.isDraft ? ", draft" : ""}) by ${who(p.author)}`,
          `${p.headRefName} -> ${p.baseRefName}; mergeable: ${p.mergeable}; review: ${p.reviewDecision || "none"}; ${p.url}`,
          "",
          cap(String(p.body || "(no description)").trim(), 4000),
          ...(p.reviews?.length ? ["", "Reviews:", ...said(p.reviews.filter((r) => r.body), 20)] : []),
          ...(p.comments?.length ? ["", "Comments:", ...said(p.comments, 20)] : []),
        ].join("\n"),
      );
    }
    if (action === "issue") {
      const fields = "number,title,state,author,labels,url,body,comments";
      const i = JSON.parse(await gh(["issue", "view", positiveInt(number, "number"), "--json", fields], top));
      return framed(
        [
          `Issue #${i.number}: ${i.title} (${i.state}) by ${who(i.author)}${i.labels?.length ? `; labels: ${i.labels.map((l) => l.name).join(", ")}` : ""}; ${i.url}`,
          "",
          cap(String(i.body || "(no description)").trim(), 4000),
          ...(i.comments?.length ? ["", "Comments:", ...said(i.comments, 20)] : []),
        ].join("\n"),
      );
    }
    if (action === "checks") {
      // gh exits non-zero while checks fail or are pending; its JSON is still the answer.
      const r = await exec("gh", ["pr", "checks", positiveInt(number, "number"), "--json", "name,bucket,link"], { cwd: top, env: ghEnv, timeoutMs: NETWORK_TIMEOUT_MS });
      let checks;
      try {
        checks = JSON.parse(r.stdout);
      } catch {
        throw new Error(`gh pr checks failed: ${cap((r.stderr || r.stdout).trim(), 500)}`);
      }
      if (!checks.length) return `${head}\nNo checks.`;
      // A PR's own workflow names its checks.
      return framed(checks.map((c) => `${c.bucket}: ${c.name} ${c.link || ""}`.trim()).join("\n"));
    }
    if (action === "run") {
      if (!/^\d{1,20}$/.test(String(runId || ""))) throw new Error("run_id must be a CI run's number");
      const summary = await gh(["run", "view", String(runId)], top);
      if (!failedLog) return framed(summary);
      const log = await gh(["run", "view", String(runId), "--log-failed"], top);
      return `${head}\n${wrapUntrusted("CI log", `${cap(summary, 3000)}\n\nFailed log (end):\n${tail(log)}`)}`;
    }
    if (action === "review_comments") {
      const jq = "[.[] | {id, path, line, user: .user.login, body, in_reply_to_id}]";
      const comments = JSON.parse(
        await gh(["api", `repos/{owner}/{repo}/pulls/${positiveInt(number, "number")}/comments?per_page=100`, "--jq", jq], top),
      );
      if (!comments.length) return `${head}\nNo review comments.`;
      return framed(
        comments
          .slice(-40)
          .map((c) => `[${c.id}${c.in_reply_to_id ? ` reply to ${c.in_reply_to_id}` : ""}] ${c.user} on ${c.path}${c.line ? `:${c.line}` : ""}: ${cap(String(c.body || "").trim(), 1000)}`)
          .join("\n"),
      );
    }
    throw new Error(`unknown action: ${action}`);
  }

  const executors = { [GIT_READ_TOOL]: gitRead, [GITHUB_READ_TOOL]: githubRead };
  return {
    listToolSchemas: () => TOOL_SCHEMAS,
    isKnownToolName: (name) => TOOL_NAMES.has(name),
    async executeTool(name, args) {
      if (!TOOL_NAMES.has(name)) throw new Error(`unknown git tool: ${name}`);
      try {
        return await executors[name](args || {});
      } catch (e) {
        return JSON.stringify({ status: "error", error: e.message || String(e) });
      }
    },
  };
}

module.exports = {
  GIT_READ_TOOL,
  GITHUB_READ_TOOL,
  createGitToolSource,
  findSecret,
  runCommand,
  stripAttribution,
  testEnv,
};
