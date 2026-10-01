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
//
// #1191: local changes (git__change), through the approval setting for
// their tier (Settings > Approvals, "Git and GitHub"): ask every time, ask
// once per repo until I say always, or no approval (still logged). Refused
// while a game runs, whatever the setting. No git stash, ever.
//
// #1192: GitHub writes (git__push of a branch that isn't the default one,
// github__write for PRs, issues, comments, labels and CI reruns), through
// the "GitHub writes" setting. What she writes there goes through the
// bridge-output sanitizer first: no keys, no local paths, no attribution.
//
// #1193: the dangerous tier, through its own setting (default: ask every
// time, and "always" never sticks): merging a PR, pushing to the default
// branch, force-pushing (with lease only), deleting a remote branch, and
// resetting or rebasing commits already pushed (or any hard reset). The
// prompt says exactly what will happen, and what runs is what it showed:
// the PR's head commit, the remote commit the lease expects.
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { resolveWithinRoot, isCredentialPath } = require("./tool-policy");
const { wrapUntrusted } = require("./untrusted-content");
const { sanitizeBridgeOutput } = require("../bridge-output-sanitizer");

const GIT_READ_TOOL = "git__read";
const GITHUB_READ_TOOL = "github__read";
const DEFAULT_ROOTS = [path.join(__dirname, "..", ".."), "D:\\GitHub Projects\\Folio"];
const REPO_ACTION_TYPE = "git-repo";
const TIMEOUT_MS = 30 * 1000;
const NETWORK_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_BUFFER = 16 * 1024 * 1024;
const MAX_OUTPUT = 12000;
// origin/main, HEAD~2, v1.0, a sha, main..feature -- never a leading dash.
const REF_RE = /^\w[\w./~^@{}-]{0,199}$/;
// Every git call: a repo's own config can't start a program on a read.
const GIT_BASE = ["-c", "core.fsmonitor=false"];
const GIT_CHANGE_TOOL = "git__change";
const GIT_PUSH_TOOL = "git__push";
const GITHUB_WRITE_TOOL = "github__write";
// A label, passed as --add-label=<it>: gh splits on commas.
const LABEL_RE = /^[^,\r\n]{1,50}$/;
const MAX_TITLE = 256;
// Under Windows' command-line limit, with the rest of the gh call.
const MAX_BODY = 20000;
const GAMING = "A game is running, so I'm leaving git alone until it's closed.";
// A commit or merge runs the repo's hooks, which may run its tests.
const HOOK_TIMEOUT_MS = 10 * 60 * 1000;
// A branch she names or creates: feat/x, mana/12-fix -- no dash first, no "..".
const BRANCH_RE = /^\w[\w./-]{0,199}$/;
const WORKTREE_NAME_RE = /^\w[\w.-]{0,63}$/;
// #1191: per tier, "ask" (every time; "always" never sticks), "once" (asked
// per repo until I say always) or "off" (no approval).
const GIT_APPROVAL_MODES = ["ask", "once", "off"];
const GIT_APPROVAL_DEFAULTS = { local: "once", github: "once", danger: "ask" };
function resolveGitApprovalModes(saved) {
  return Object.fromEntries(
    Object.entries(GIT_APPROVAL_DEFAULTS).map(([tier, mode]) => [tier, GIT_APPROVAL_MODES.includes(saved?.[tier]) ? saved[tier] : mode]),
  );
}

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
      // Past the buffer is a failure, never a cut-short success: a diff the
      // secret scan only saw part of must not pass it.
      const tooBig = err?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      const timedOut = Boolean(err?.killed) && !tooBig;
      const code = !err ? 0 : typeof err.code === "number" ? err.code : 1;
      const why = tooBig
        ? `its output passed ${MAX_BUFFER / 1024 / 1024} MB; narrow it down`
        : timedOut
          ? `timed out after ${timeoutMs / 1000}s`
          : err?.message || "";
      resolve({ code, stdout: String(stdout || ""), stderr: tooBig || timedOut ? why : String(stderr || why), timedOut });
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

function checkBranch(name) {
  const s = String(name ?? "");
  if (!BRANCH_RE.test(s) || s === "HEAD" || /\.\.|\/\/|[/.]$|\.lock$/.test(s)) throw new Error(`"${s}" isn't a branch name I can use`);
  return s;
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
      description:
        "Read a git repo: status, diff (capped), log, show a commit, list branches, or list the files with merge conflicts. Changes nothing.",
      parameters: {
        type: "object",
        properties: {
          repo: REPO_PARAM,
          action: { type: "string", enum: ["status", "diff", "log", "show", "branches", "conflicts"] },
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
      name: GIT_CHANGE_TOOL,
      description:
        "Change a git repo on this PC: switch (or create) a branch, add or remove a worktree, stage files, commit, fetch, pull (merges), merge a ref such as origin/main into the current branch, abort a merge, reset, or rebase (and continue or abort it). Resolve conflicts by editing the files, then stage and commit. The user's approval setting decides whether it asks first; if it asks, it runs once they allow it.",
      parameters: {
        type: "object",
        properties: {
          repo: REPO_PARAM,
          action: {
            type: "string",
            enum: [
              "switch", "worktree_add", "worktree_remove", "stage", "commit", "fetch", "pull", "merge", "merge_abort",
              "reset", "rebase", "rebase_continue", "rebase_abort",
            ],
          },
          branch: { type: "string", description: "switch/worktree_add: the branch." },
          create: { type: "boolean", description: "switch/worktree_add: create the branch." },
          start: { type: "string", description: "switch/worktree_add with create: where the new branch starts (default HEAD)." },
          name: { type: "string", description: "worktree_add/worktree_remove: the worktree's folder name, next to the repo in <repo>-worktrees." },
          paths: { type: "array", items: { type: "string" }, description: "stage: the files or folders." },
          all: { type: "boolean", description: "stage: every change, new files included." },
          message: { type: "string", description: "commit: the message (first line a short title). No Co-authored-by lines." },
          ref: { type: "string", description: "merge: what to merge in (default origin/<default branch>). reset/rebase: where to." },
          mode: { type: "string", enum: ["soft", "mixed", "hard"], description: "reset. Default mixed; hard discards uncommitted changes." },
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
  {
    type: "function",
    function: {
      name: GIT_PUSH_TOOL,
      description:
        "Push a branch to origin on GitHub, force-push it (with lease), or delete it on origin. The user's approval setting decides whether it asks first; if it asks, it runs once they allow it.",
      parameters: {
        type: "object",
        properties: {
          repo: REPO_PARAM,
          branch: { type: "string", description: "The local branch. Default: the current one." },
          force: { type: "boolean", description: "Force-push, with a lease on what origin has now." },
          delete: { type: "boolean", description: "Delete this branch on origin instead." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: GITHUB_WRITE_TOOL,
      description:
        "Write to the repo on GitHub: open, edit, comment on or merge a PR; open, edit, comment on or close an issue; add or remove labels (with an edit); rerun a CI run's failed jobs. Written in first person as the user. The user's approval setting decides whether it asks first.",
      parameters: {
        type: "object",
        properties: {
          repo: REPO_PARAM,
          action: {
            type: "string",
            enum: ["pr_create", "pr_edit", "pr_comment", "pr_merge", "issue_create", "issue_edit", "issue_comment", "issue_close", "rerun_failed"],
          },
          number: { type: "integer", description: "The PR or issue number (edit, comment, close)." },
          title: { type: "string", description: "pr_create/issue_create, or a new title with an edit." },
          body: { type: "string", description: "The description or comment (markdown)." },
          head: { type: "string", description: "pr_create: the branch with the changes. Default: the current one." },
          base: { type: "string", description: "pr_create: the branch to merge into. Default: the default branch." },
          draft: { type: "boolean", description: "pr_create: open it as a draft." },
          add_labels: { type: "array", items: { type: "string" }, description: "Labels to add (edit, issue_create)." },
          remove_labels: { type: "array", items: { type: "string" }, description: "Labels to remove (edit)." },
          reason: { type: "string", enum: ["completed", "not_planned"], description: "issue_close. Default completed." },
          run_id: { type: "string", description: "rerun_failed: the CI run's id." },
          method: { type: "string", enum: ["merge", "squash", "rebase"], description: "pr_merge. Default merge." },
        },
        required: ["action"],
      },
    },
  },
];
const TOOL_NAMES = new Set(TOOL_SCHEMAS.map((t) => t.function.name));

// options.roots: the folders whose repos she may use (default above).
// options.approvalGate: asks me about a repo outside them, and about changes.
// options.isGaming: changes are refused while it's true.
// options.exec/env: injectable for tests.
function createGitToolSource(options = {}) {
  const exec = options.exec || runCommand;
  const env = options.env || process.env;
  const approvalGate = options.approvalGate || null;
  const isGaming = options.isGaming || (() => false);
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
    // d:/mana: what her approvals for this repo are keyed by.
    const id = main.replace(/\\/g, "/").toLowerCase();
    const key = `${REPO_ACTION_TYPE}:${id}`;
    const repo = { top, main, id };
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
    if (action === "conflicts") {
      const files = await conflictList(top);
      return `${head}\n${files.length ? files.join("\n") : "No conflicts."}`;
    }
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

  async function conflictList(top) {
    return (await git(["diff", "--name-only", "--diff-filter=U"], top)).split(/\r?\n/).filter(Boolean);
  }

  // #1191: a change runs through its tier's setting. "off" runs it now
  // (unless I said never), logged in the approvals audit; otherwise the
  // gate asks -- "ask" as forceReview, so "always" never sticks -- and runs
  // it once I allow it. payload: plain JSON of the checked change.
  async function gated(tier, repo, summary, payload) {
    if (isGaming()) throw new Error(GAMING);
    if (!approvalGate) throw new Error("changes need the approval gate");
    const mode = resolveGitApprovalModes(approvalGate.getGitApprovalModes())[tier];
    const actionType = `git-${tier}:${repo.id}`;
    approvalGate.registerExecutor(actionType, perform);
    const never = approvalGate.listRemembered().some((r) => r.key === actionType && r.answer === "never");
    if (mode === "off" && !never) {
      const entry = { name: actionType, args: payload, decision: "no approval (setting)", summary };
      try {
        const result = await perform(payload);
        approvalGate.guardianAuditLog.append({ ...entry, ok: true });
        return result;
      } catch (e) {
        approvalGate.guardianAuditLog.append({ ...entry, ok: false, error: e.message });
        throw e;
      }
    }
    const outcome = await approvalGate.requestApproval(actionType, { summary, payload, forceReview: mode === "ask" });
    if (outcome.status === "approved") return outcome.result;
    if (outcome.status === "pending") {
      return JSON.stringify({
        status: "pending",
        requestId: outcome.requestId,
        asked: summary,
        note: "It runs once the user allows it in Approvals. Tell them what you asked for; don't ask again.",
      });
    }
    throw new Error(`not allowed: ${outcome.reason || outcome.status}`);
  }

  // Runs an approved change; a game may have started since it was asked.
  function perform(payload) {
    if (isGaming()) throw new Error(GAMING);
    return changes[payload.action](payload);
  }

  // A merge or a pull may stop at conflicts: that's a result for her to
  // work on, not a failure.
  async function mergeLike(args, top, what, abort = "merge_abort") {
    // No editor to wait for: a rebase --continue keeps each message.
    const r = await exec("git", [...GIT_BASE, ...args], { cwd: top, env: { ...gitEnv, GIT_EDITOR: "true" }, timeoutMs: HOOK_TIMEOUT_MS });
    if (r.code === 0) return cap(`${what}: done.\n${r.stdout.trim()}`);
    const conflicts = await conflictList(top);
    if (!conflicts.length) throw new Error(`git ${args[0]} failed: ${cap((r.stderr || r.stdout).trim(), 500)}`);
    return `${what} stopped at conflicts in:\n${conflicts.join("\n")}\nEdit those files, then stage them and ${abort === "merge_abort" ? "commit" : "rebase_continue"} (or ${abort}).`;
  }

  // A node_modules link (a junction on Windows) is unlinked first, as a
  // link: removing the worktree must never delete through it into the live
  // packages. If one can't be unlinked, that throws and nothing is removed.
  function unlinkModules(wt) {
    const dirs = fs
      .readdirSync(wt, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== ".git")
      .map((d) => path.join(wt, d.name));
    for (const link of [wt, ...dirs].map((d) => path.join(d, "node_modules"))) {
      let stat = null;
      try {
        stat = fs.lstatSync(link);
      } catch {}
      if (stat?.isSymbolicLink()) fs.unlinkSync(link);
    }
  }

  const changes = {
    async switch({ top, branch, create, start }) {
      await git(["switch", ...(create ? ["-c", branch, ...(start ? [start] : [])] : [branch])], top);
      return `Switched ${top} to ${branch}.`;
    },
    async worktree_add({ top, wt, branch, create, start }) {
      await git(["worktree", "add", ...(create ? ["-b", branch, wt, ...(start ? [start] : [])] : [wt, branch])], top);
      return `Added the worktree ${wt} on ${branch}.`;
    },
    async worktree_remove({ top, wt }) {
      unlinkModules(wt);
      await git(["worktree", "remove", wt], top);
      return `Removed the worktree ${wt}.`;
    },
    async stage({ top, paths, all }) {
      await git(["add", ...(all ? ["-A"] : ["--", ...paths])], top);
      return `Staged. Now:\n${cap(await git(["status", "--short"], top))}`;
    },
    // The secret scan runs here, on what's staged when it actually commits.
    async commit({ top, message }) {
      const diff = await git(["diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv"], top);
      if (!diff.trim()) throw new Error("nothing is staged to commit");
      const secret = findSecret(diff, env);
      if (secret) throw new Error(`the staged changes have ${secret} in them, so I didn't commit`);
      await git(["commit", "-m", message], top, HOOK_TIMEOUT_MS);
      return `Committed: ${(await git(["log", "-1", "--format=%h %s"], top)).trim()}`;
    },
    async fetch({ top }) {
      await git(["fetch", "--prune", "origin"], top, NETWORK_TIMEOUT_MS);
      return "Fetched origin.";
    },
    pull: ({ top }) => mergeLike(["pull", "--no-rebase", "--no-edit"], top, "Pull"),
    merge: ({ top, ref }) => mergeLike(["merge", "--no-edit", ref], top, `Merging ${ref}`),
    async merge_abort({ top }) {
      await git(["merge", "--abort"], top);
      return "Aborted the merge.";
    },
    // #1192: the GitHub writes. The outgoing diff gets the secret scan
    // again when it's pushed, whoever made its commits.
    // lease: the remote commit a force-push may replace, and only that one.
    async push({ top, branch, base, lease }) {
      const diff = await git(["diff", "--no-color", "--no-ext-diff", "--no-textconv", base, branch], top);
      const secret = findSecret(diff, env);
      if (secret) throw new Error(`the changes I'd push have ${secret} in them, so I didn't push`);
      const force = lease ? [`--force-with-lease=refs/heads/${branch}:${lease}`] : [];
      await git(["push", ...force, "-u", "origin", `${branch}:refs/heads/${branch}`], top, HOOK_TIMEOUT_MS);
      return `${lease ? "Force-pushed" : "Pushed"} ${branch} to origin.`;
    },
    async delete_remote({ top, branch, lease }) {
      await git(["push", `--force-with-lease=refs/heads/${branch}:${lease}`, "origin", `:refs/heads/${branch}`], top, NETWORK_TIMEOUT_MS);
      return `Deleted ${branch} on origin.`;
    },
    // sha: the head commit the prompt showed; gh refuses if the PR moved.
    async pr_merge({ top, number, method, sha }) {
      await gh(["pr", "merge", number, `--${method}`, `--match-head-commit=${sha}`], top);
      return `Merged PR #${number}.`;
    },
    async reset({ top, ref, mode }) {
      await git(["reset", `--${mode}`, ref], top);
      return `Reset to ${ref} (${mode}). Now:\n${cap(await git(["status", "--short", "--branch"], top))}`;
    },
    rebase: ({ top, ref }) => mergeLike(["rebase", ref], top, `Rebasing onto ${ref}`, "rebase_abort"),
    rebase_continue: ({ top }) => mergeLike(["rebase", "--continue"], top, "Rebase", "rebase_abort"),
    async rebase_abort({ top }) {
      await git(["rebase", "--abort"], top);
      return "Aborted the rebase.";
    },
    async pr_create({ top, head, base, title, body, draft }) {
      const out = await gh(["pr", "create", `--base=${base}`, `--head=${head}`, `--title=${title}`, `--body=${body}`, ...(draft ? ["--draft"] : [])], top);
      return `Opened ${out.trim().split(/\s+/).pop()}`;
    },
    async edit({ top, kind, number, title, body, add, remove }) {
      const labels = [...add.map((l) => `--add-label=${l}`), ...remove.map((l) => `--remove-label=${l}`)];
      await gh([kind, "edit", number, ...(title ? [`--title=${title}`] : []), ...(body ? [`--body=${body}`] : []), ...labels], top);
      return `Edited ${kind} #${number}.`;
    },
    async comment({ top, kind, number, body }) {
      return `Commented: ${(await gh([kind, "comment", number, `--body=${body}`], top)).trim()}`;
    },
    async issue_create({ top, title, body, labels }) {
      const out = await gh(["issue", "create", `--title=${title}`, `--body=${body}`, ...labels.map((l) => `--label=${l}`)], top);
      return `Opened ${out.trim().split(/\s+/).pop()}`;
    },
    async issue_close({ top, number, body, reason }) {
      await gh(["issue", "close", number, `--reason=${reason}`, ...(body ? [`--comment=${body}`] : [])], top);
      return `Closed issue #${number} as ${reason}.`;
    },
    async rerun_failed({ top, runId }) {
      await gh(["run", "rerun", runId, "--failed"], top);
      return `Rerunning the failed jobs of run ${runId}.`;
    },
  };

  // The branch origin/HEAD points at, else main.
  async function defaultBranch(top) {
    const r = await exec("git", [...GIT_BASE, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: top, env: gitEnv });
    return r.code === 0 ? r.stdout.trim().replace(/^origin\//, "") : "main";
  }

  async function currentBranch(top) {
    return (await git(["rev-parse", "--abbrev-ref", "HEAD"], top)).trim();
  }

  // The default branch as GitHub says, else as origin/HEAD says.
  async function remoteDefault(top) {
    const r = await exec("gh", ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], { cwd: top, env: ghEnv, timeoutMs: NETWORK_TIMEOUT_MS });
    return (r.code === 0 && r.stdout.trim()) || defaultBranch(top);
  }

  // What she writes to GitHub: no attribution lines, keys or local paths.
  const outgoing = (text, max) => cap(sanitizeBridgeOutput(stripAttribution(text), { env }), max);
  const labelList = (list) =>
    (Array.isArray(list) ? list : []).map((l) => {
      const s = String(l).trim();
      if (!LABEL_RE.test(s)) throw new Error(`"${s}" isn't a label I can use`);
      return s;
    });
  const preview = (body) => (body ? `: "${body.slice(0, 300)}${body.length > 300 ? "..." : ""}"` : "");

  async function gitPush(args) {
    const repo = await openRepo(args.repo);
    const { top } = repo;
    const branch = checkBranch(args.branch || (await currentBranch(top)));
    const main = await remoteDefault(top);
    // main and master count too, in case the lookup fell back to a guess.
    const isDefault = [main, "main", "master"].includes(branch);
    const remoteSha = async () => {
      const r = await exec("git", [...GIT_BASE, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], { cwd: top, env: gitEnv });
      return r.code === 0 ? r.stdout.trim() : null;
    };
    const count = async (range) => (await git(["rev-list", "--count", range], top)).trim();
    const lease = await remoteSha();
    if (args.delete) {
      if (isDefault) throw new Error(`${branch} is the default branch; I never delete it`);
      if (!lease) throw new Error(`origin has no ${branch} that I know of (fetch first)`);
      return gated("danger", repo, `Delete the branch ${branch} on origin, from ${repo.main} (at ${lease.slice(0, 8)}; ${await count(`origin/${main}..${lease}`)} commit(s) on it aren't on ${main})`, {
        action: "delete_remote", top, branch, lease,
      });
    }
    await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], top);
    const onDefault = isDefault ? `, the default branch,` : "";
    if (args.force && lease) {
      const dropped = await count(`${branch}..${lease}`);
      return gated("danger", repo, `Force-push ${branch}${onDefault} to origin from ${repo.main}, with lease: drops ${dropped} commit(s) now on origin and pushes ${await count(`${lease}..${branch}`)}`, {
        action: "push", top, branch, base: lease, lease,
      });
    }
    // Against its own remote branch, else the default branch it starts from.
    const base = lease || (await git(["merge-base", `origin/${main}`, branch], top)).trim();
    const commits = `${await count(`${base}..${branch}`)} commit(s)${lease ? "" : ", a new branch"}`;
    if (isDefault) return gated("danger", repo, `Push ${commits} to ${branch}${onDefault} on origin, from ${repo.main}`, { action: "push", top, branch, base });
    return gated("github", repo, `Push ${branch} (${commits}) to origin from ${repo.main}`, { action: "push", top, branch, base });
  }

  async function githubWrite(args) {
    const repo = await openRepo(args.repo);
    const { top } = repo;
    const where = `in ${repo.main}`;
    const github = (summary, payload) => gated("github", repo, summary, { top, ...payload });
    const title = () => {
      const t = outgoing(args.title, MAX_TITLE).split(/\r?\n/)[0].trim();
      if (!t) throw new Error("title is required");
      return t;
    };
    const body = (required) => {
      const b = outgoing(args.body, MAX_BODY);
      if (required && !b) throw new Error("body is required");
      return b;
    };
    const kind = /^pr_/.test(args.action) ? "pr" : "issue";
    const named = async () => {
      const number = positiveInt(args.number, "number");
      const current = (await gh([kind, "view", number, "--json", "title", "--jq", ".title"], top)).trim();
      return { number, label: `${kind === "pr" ? "PR" : "issue"} #${number} ("${current}")` };
    };
    switch (args.action) {
      case "pr_create": {
        const head = checkBranch(args.head || (await currentBranch(top)));
        const base = checkBranch(args.base || (await remoteDefault(top)));
        if (head === base) throw new Error("head and base are the same branch");
        const t = title();
        const b = body(false);
        return github(`Open a ${args.draft ? "draft " : ""}PR ${where}: ${head} -> ${base}, "${t}"${preview(b)}`, {
          action: "pr_create", head, base, title: t, body: b, draft: Boolean(args.draft),
        });
      }
      case "pr_edit":
      case "issue_edit": {
        const { number, label } = await named();
        const t = args.title ? title() : "";
        const b = body(false);
        const add = labelList(args.add_labels);
        const remove = labelList(args.remove_labels);
        const parts = [t && `title "${t}"`, b && `description${preview(b)}`, add.length && `add labels ${add.join(", ")}`, remove.length && `remove labels ${remove.join(", ")}`].filter(Boolean);
        if (!parts.length) throw new Error("nothing to change");
        return github(`Edit ${label} ${where}: ${parts.join("; ")}`, { action: "edit", kind, number, title: t, body: b, add, remove });
      }
      case "pr_merge": {
        const number = positiveInt(args.number, "number");
        const fields = "title,state,isDraft,headRefName,baseRefName,headRefOid,commits";
        const p = JSON.parse(await gh(["pr", "view", number, "--json", fields], top));
        if (p.state !== "OPEN") throw new Error(`PR #${number} is ${String(p.state).toLowerCase()}`);
        const method = ["merge", "squash", "rebase"].includes(args.method) ? args.method : "merge";
        // gh exits non-zero while checks fail or are pending; its JSON is still the answer.
        const r = await exec("gh", ["pr", "checks", number, "--json", "name,bucket"], { cwd: top, env: ghEnv, timeoutMs: NETWORK_TIMEOUT_MS });
        let checks = [];
        try {
          checks = JSON.parse(r.stdout);
        } catch {}
        const notGreen = checks.filter((c) => !["pass", "skipping"].includes(c.bucket));
        const checkText = !checks.length
          ? "no checks"
          : notGreen.length
            ? `checks NOT green: ${notGreen.map((c) => `${c.name} (${c.bucket})`).join(", ")}`
            : "checks green";
        const summary = `Merge PR #${number} "${p.title}" in ${repo.main} (${method}): ${p.headRefName} -> ${p.baseRefName}, ${(p.commits || []).length} commit(s); ${checkText}${p.isDraft ? "; it's a draft" : ""}`;
        return gated("danger", repo, summary, { top, action: "pr_merge", number, method, sha: p.headRefOid });
      }
      case "pr_comment":
      case "issue_comment": {
        const { number, label } = await named();
        const b = body(true);
        return github(`Comment on ${label} ${where}${preview(b)}`, { action: "comment", kind, number, body: b });
      }
      case "issue_create": {
        const t = title();
        const b = body(false);
        const labels = labelList(args.add_labels);
        return github(`Open an issue ${where}: "${t}"${preview(b)}${labels.length ? ` (labels ${labels.join(", ")})` : ""}`, {
          action: "issue_create", title: t, body: b, labels,
        });
      }
      case "issue_close": {
        const { number, label } = await named();
        const b = body(false);
        const reason = args.reason === "not_planned" ? "not planned" : "completed";
        return github(`Close ${label} ${where} as ${reason}${b ? `, commenting${preview(b)}` : ""}`, { action: "issue_close", number, body: b, reason });
      }
      case "rerun_failed": {
        if (!/^\d{1,20}$/.test(String(args.run_id || ""))) throw new Error("run_id must be a CI run's number");
        return github(`Rerun the failed jobs of CI run ${args.run_id} ${where}`, { action: "rerun_failed", runId: String(args.run_id) });
      }
      default:
        throw new Error(`unknown action: ${args.action}`);
    }
  }

  // Checks what she asked for, then hands it to gated() with a summary
  // that says exactly what will happen.
  async function gitChange(args) {
    const repo = await openRepo(args.repo);
    const { top } = repo;
    const on = (await git(["rev-parse", "--abbrev-ref", "HEAD"], top)).trim();
    const where = `${top} (on ${on})`;
    const local = (summary, payload) => gated("local", repo, summary, { top, ...payload });
    const branchArgs = () => {
      const branch = checkBranch(args.branch);
      const start = args.create && args.start ? checkRef(args.start) : undefined;
      return { branch, create: Boolean(args.create), start };
    };
    const describe = ({ branch, create, start }) => `${create ? "a new branch " : ""}${branch}${start ? ` from ${start}` : ""}`;
    const worktree = () => {
      if (!WORKTREE_NAME_RE.test(String(args.name || ""))) throw new Error("name must be a plain folder name");
      return path.join(path.dirname(repo.main), `${path.basename(repo.main)}-worktrees`, args.name);
    };
    switch (args.action) {
      case "switch": {
        const b = branchArgs();
        return local(`Switch ${where} to ${describe(b)}`, { action: "switch", ...b });
      }
      case "worktree_add": {
        const b = branchArgs();
        const wt = worktree();
        if (fs.existsSync(wt)) throw new Error(`${wt} already exists`);
        return local(`Add a worktree of ${repo.main} at ${wt} on ${describe(b)}`, { action: "worktree_add", wt, ...b });
      }
      case "worktree_remove": {
        const wt = worktree();
        const listed = (await git(["worktree", "list", "--porcelain"], top))
          .split(/\r?\n/)
          .filter((l) => l.startsWith("worktree "))
          .map((l) => path.resolve(l.slice("worktree ".length)));
        // The first one listed is the main checkout itself.
        if (!listed.slice(1).some((p) => within(p, wt) && within(wt, p))) throw new Error(`${wt} isn't one of ${repo.main}'s worktrees`);
        return local(`Remove the worktree ${wt} (a node_modules link in it is unlinked first, never deleted through)`, { action: "worktree_remove", wt });
      }
      case "stage": {
        if (args.all) return local(`Stage every change in ${where}`, { action: "stage", all: true });
        const paths = (Array.isArray(args.paths) ? args.paths : []).map((p) => repoPath(top, p));
        if (!paths.length) throw new Error("give paths, or all: true");
        return local(`Stage ${paths.join(", ")} in ${where}`, { action: "stage", paths });
      }
      case "commit": {
        const message = cap(stripAttribution(args.message), 5000);
        if (!message) throw new Error("a commit needs a message");
        const files = (await git(["diff", "--cached", "--name-only"], top)).split(/\r?\n/).filter(Boolean);
        if (!files.length) throw new Error("nothing is staged to commit");
        return local(`Commit ${files.length} staged file(s) in ${where}: "${message.split(/\r?\n/)[0]}"`, { action: "commit", message });
      }
      case "fetch":
        return local(`Fetch from origin in ${top}`, { action: "fetch" });
      case "pull":
        return local(`Pull origin into ${where}, merging (not rebasing)`, { action: "pull" });
      case "merge": {
        const ref = args.ref ? checkRef(args.ref) : `origin/${await defaultBranch(top)}`;
        return local(`Merge ${ref} into ${where}`, { action: "merge", ref });
      }
      case "merge_abort":
        return local(`Abort the merge in progress in ${where}`, { action: "merge_abort" });
      case "rebase_abort":
        return local(`Abort the rebase in progress in ${where}`, { action: "rebase_abort" });
      case "rebase_continue":
        return local(`Continue the rebase in progress in ${where}`, { action: "rebase_continue" });
      // #1193: dangerous once it rewrites anything already pushed, or
      // throws away uncommitted work (a hard reset).
      case "reset":
      case "rebase": {
        if (!args.ref) throw new Error("ref is required");
        const ref = checkRef(args.ref);
        const mode = args.action === "reset" ? (["soft", "mixed", "hard"].includes(args.mode) ? args.mode : "mixed") : undefined;
        const count = async (...extra) => Number((await git(["rev-list", "--count", `${ref}..HEAD`, ...extra], top)).trim());
        const total = await count();
        const pushed = total - (await count("--not", "--remotes"));
        const tier = pushed > 0 || mode === "hard" ? "danger" : "local";
        const rewrites = `${total} commit(s), ${pushed} of them already pushed`;
        const summary =
          args.action === "reset"
            ? `Reset ${where} to ${ref} (${mode}${mode === "hard" ? ", throwing away uncommitted changes" : ""}): takes ${rewrites} off the branch`
            : `Rebase ${where} onto ${ref}: rewrites ${rewrites}`;
        return gated(tier, repo, summary, { top, action: args.action, ref, mode });
      }
      default:
        throw new Error(`unknown action: ${args.action}`);
    }
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

  const executors = {
    [GIT_READ_TOOL]: gitRead,
    [GIT_CHANGE_TOOL]: gitChange,
    [GIT_PUSH_TOOL]: gitPush,
    [GITHUB_READ_TOOL]: githubRead,
    [GITHUB_WRITE_TOOL]: githubWrite,
  };
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
  GIT_APPROVAL_DEFAULTS,
  GIT_APPROVAL_MODES,
  GIT_CHANGE_TOOL,
  GIT_PUSH_TOOL,
  GIT_READ_TOOL,
  GITHUB_READ_TOOL,
  GITHUB_WRITE_TOOL,
  createGitToolSource,
  findSecret,
  resolveGitApprovalModes,
  runCommand,
  stripAttribution,
  testEnv,
};
