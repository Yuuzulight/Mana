// #976 / #1006: Mana works one of my issues on her own repo. A worktree
// under D:\Mana-worktrees\mana-<N> from a fresh origin/main, on branch
// mana/<N>-<slug> (never her live checkout, never main); goal mode (#787)
// as the loop, with tools that only reach that worktree; then a commit, a
// push of her own branch and a PR via gh that says "Closes #N". She never
// merges. Writes apply directly in her worktree once they parse and the
// adversarial reviewer (#788 / #622) doesn't refute them; a refuted write
// stops the run and asks me. I review everything in the PR.
//
// ponytail: one run at a time, state in memory -- a backend restart ends
// the run and leaves the worktree for the next one to pick up.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { resolveWithinRoot, isCredentialPath } = require("./ai/tool-policy");
const { CODING_EDIT_TOOL_NAME, CODING_TEST_TOOL_NAME, runTestCommand } = require("./ai/coding-tool-source");
const {
  SESSION_GOAL_FINISH_TOOL_NAME,
  TOOL_SCHEMAS: GOAL_TOOL_SCHEMAS,
  createSessionGoalToolSource,
} = require("./ai/session-goal-tool-source");
const { createEditProposalStore } = require("./zed-integration");

// The label that makes an issue hers to work on. I add it (or starting a
// run from the launcher adds it for me).
const TASK_LABEL = "mana-task";
const MAX_ROUNDS = 20;
const TEST_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_READ_LINES = 250;
const MAX_LIST = 100;
const MAX_LOG = 30;

// #1007: her budget isn't time. It's how many of her PRs may wait for my
// review at once; she pauses when that many are open.
const DEFAULT_MAX_OPEN_PRS = 2;
const MAX_RAM_PERCENT = 85;
const RAM_WAIT_MS = 10 * 60 * 1000;
// A run with this many tool calls in a row and no new change and no new
// test result is stuck (on top of goal mode's 20-round cap).
const MAX_STEPS_WITHOUT_PROGRESS = 8;
// Starting on her own while I'm away stays off until #1001 and the fixes
// for #1002 (args.approved), #1003 (mana/test/run's cwd) and #1004
// (acp-path-guard.js) are merged. Flip it then.
const UNATTENDED_ALLOWED = false;

function systemRamPercent() {
  return Math.round((1 - os.freemem() / os.totalmem()) * 1000) / 10;
}

// #1000's guardrail list. Until it's merged into this checkout the runner
// refuses to start: her writes must not reach her own guardrails.
function loadProtectedPaths() {
  try {
    return require("./protected-paths");
  } catch {
    return null;
  }
}

// The code she writes runs in her tests; it gets a clean environment, not
// the backend's keys and tokens.
const TEST_ENV_KEYS = new Set(
  [
    "PATH", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "TEMP", "TMP", "USERPROFILE",
    "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
    "ProgramData", "CommonProgramFiles", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "DOTNET_ROOT",
  ].map((k) => k.toLowerCase()),
);
function testEnv(env) {
  const clean = Object.fromEntries(Object.entries(env).filter(([k]) => TEST_ENV_KEYS.has(k.toLowerCase())));
  return { ...clean, NODE_ENV: "test", DOTNET_CLI_TELEMETRY_OPTOUT: "1" };
}

// Secret shapes, and the backend's own secret values, in the lines she adds.
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

function slugify(title) {
  return (
    String(title || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "task"
  );
}

// Lines that would credit someone else with the change -- never in her commits or PRs.
function stripAttribution(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((l) => !/^\s*(co-authored-by|signed-off-by)\s*:|generated (with|by)\b/i.test(l))
    .join("\n")
    .trim();
}

function defaultExec(cmd, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, env, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout || ""), stderr: String(stderr || (err && err.message) || "") });
    });
  });
}

// The worktree's own tools for goal mode. Named like the chat's coding
// tools so goal mode's completion review (#787) checks for an edit and a
// passing test run after it, but they write straight into her worktree.
const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "self_work__files",
      description: "List files in your worktree whose path contains the given text (case-insensitive).",
      parameters: { type: "object", properties: { contains: { type: "string" } }, required: ["contains"] },
    },
  },
  {
    type: "function",
    function: {
      name: "self_work__search",
      description: "Search the worktree's tracked files for an exact text. Returns path:line: text matches.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          path: { type: "string", description: "Optional file or folder to search in." },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "self_work__read",
      description: `Read lines of a file in your worktree, with line numbers (at most ${MAX_READ_LINES} lines per call).`,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "integer", description: "First line, 1-based. Default 1." },
          end_line: { type: "integer" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: CODING_EDIT_TOOL_NAME,
      description:
        "Change a file in your worktree: old_text must match the file exactly once and is replaced by new_text. For a new file, leave old_text empty and put the whole file in new_text. It has to parse, and your adversarial reviewer checks it before it's written.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
          summary: { type: "string", description: "One line on what the change does." },
        },
        required: ["path", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: CODING_TEST_TOOL_NAME,
      description:
        "Run tests in your worktree: a node-bot test file (node-bot/test/x.test.js), a launcher test file (windows-native-launcher/ManaNativeLauncher.Tests/XTests.cs), or no path for the whole node-bot suite.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  },
];

function createSelfWork(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, ".."));
  const worktreesDir = path.resolve(options.worktreesDir || path.join(path.dirname(repoRoot), "Mana-worktrees"));
  const exec = options.exec || defaultExec;
  const env = options.env || process.env;
  const runLoop = options.runLoop;
  const reviewEdit = options.reviewEdit || null;
  const guard = options.protectedPaths === undefined ? loadProtectedPaths() : options.protectedPaths;
  const runTests = options.runTests || runTestCommand;
  const isGaming = options.isGaming || (() => false);
  const ramPercent = options.ramPercent || systemRamPercent;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxOpenPrs = Math.max(1, Number(env.MANA_SELF_WORK_MAX_OPEN_PRS) || DEFAULT_MAX_OPEN_PRS);
  const unattendedAllowed = options.unattendedAllowed ?? UNATTENDED_ALLOWED;
  const onEvent = options.onEvent || ((run, text) => console.log(`[self-work #${run.issue}] ${text}`));
  const proposals = createEditProposalStore();
  let current = null;

  async function run(cmd, args, cwd) {
    const r = await exec(cmd, args, { cwd, env });
    if (r.code !== 0) throw new Error(`${cmd} ${args.slice(0, 2).join(" ")} failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
    return r.stdout.trim();
  }
  const git = (args, cwd = repoRoot) => run("git", args, cwd);
  const gh = (args, cwd = repoRoot) => run("gh", args, cwd);

  function log(r, text) {
    r.step = text;
    r.log.push({ at: new Date().toISOString(), text });
    if (r.log.length > MAX_LOG) r.log.shift();
    try {
      onEvent(r, text);
    } catch {}
  }

  function status() {
    if (!current) return { state: "idle" };
    const { done, stopRequested, lastTestPassed, halt, ...shown } = current;
    return { ...shown, log: [...current.log] };
  }

  // The worktree and branch she may use for issue n; anything that could
  // land on her live checkout or on main is refused.
  function placeFor(n, title) {
    const worktree = path.join(worktreesDir, `mana-${n}`);
    const branch = `mana/${n}-${slugify(title)}`;
    const within = (outer, inner) => {
      const rel = path.relative(outer, inner);
      return !rel || (!rel.startsWith("..") && !path.isAbsolute(rel));
    };
    if (within(repoRoot, worktree) || within(worktree, repoRoot)) {
      throw new Error(`${worktree} overlaps my live checkout`);
    }
    if (!/^mana\/\d+-[a-z0-9-]+$/.test(branch)) throw new Error(`bad branch name ${branch}`);
    return { worktree, branch };
  }

  // One run at a time, including while one is still being set up.
  let starting = false;
  async function start(issueNumber) {
    if (starting || current?.state === "running") return { ok: false, error: "I'm already working on an issue." };
    starting = true;
    try {
      return await begin(issueNumber);
    } finally {
      starting = false;
    }
  }

  // Why she shouldn't start now, or null.
  async function blocker() {
    if (isGaming()) return "A game is running, so I'm leaving my code alone.";
    const ram = ramPercent();
    if (ram > MAX_RAM_PERCENT) return `RAM is at ${ram}%, so I'm not starting.`;
    const open = await myOpenPrs();
    if (open.length >= maxOpenPrs) {
      return `${open.length} of my PRs are waiting for your review (${open.map((p) => `#${p.number}`).join(", ")}), so I'll wait until you get to them.`;
    }
    return null;
  }

  async function myOpenPrs() {
    const prs = JSON.parse(await gh(["pr", "list", "--state", "open", "--author", "@me", "--limit", "100", "--json", "number,headRefName"]));
    return prs.filter((p) => p.headRefName.startsWith("mana/"));
  }

  // #1007: called once per idle period of 20 minutes or more. Only issues
  // already labelled for her, without a PR of hers yet.
  async function startIdle() {
    if (!unattendedAllowed) return { ok: false, error: "Starting on my own is off until my security fixes are merged." };
    if (starting || current?.state === "running") return { ok: false, error: "I'm already working on an issue." };
    let issues;
    try {
      const open = await myOpenPrs();
      issues = JSON.parse(
        await gh(["issue", "list", "--state", "open", "--label", TASK_LABEL, "--limit", "50", "--json", "number"]),
      )
        .map((i) => i.number)
        .filter((n) => !open.some((p) => p.headRefName.startsWith(`mana/${n}-`)))
        .sort((a, b) => a - b);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    if (!issues.length) return { ok: false, error: "No issue is waiting for me." };
    return start(issues[0]);
  }

  async function begin(issueNumber) {
    if (!guard) return { ok: false, error: "Self-work waits for my guardrail list (#1000) to be merged into this checkout." };
    let why;
    try {
      why = await blocker();
    } catch (e) {
      return { ok: false, error: e.message };
    }
    if (why) return { ok: false, error: why };
    const n = Number(issueNumber);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "Which issue? Give me its number." };
    let issue;
    try {
      issue = JSON.parse(await gh(["issue", "view", String(n), "--json", "number,title,body,state,labels"]));
    } catch (e) {
      return { ok: false, error: e.message };
    }
    if (issue.state !== "OPEN") return { ok: false, error: `#${n} isn't open.` };
    let place;
    try {
      place = placeFor(n, issue.title);
      // Started by me, so it's assigned to her: the label records that.
      if (!(issue.labels || []).some((l) => l.name === TASK_LABEL)) {
        await gh(["label", "create", TASK_LABEL, "--force", "--color", "C5A3FF", "--description", "Mana may work on this"]);
        await gh(["issue", "edit", String(n), "--add-label", TASK_LABEL]);
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const r = {
      state: "running",
      issue: n,
      title: issue.title,
      ...place,
      startedAt: new Date().toISOString(),
      step: "",
      log: [],
      prUrl: null,
      stopRequested: false,
      lastTestPassed: false,
    };
    current = r;
    r.done = work(r, issue).catch((e) => end(r, "failed", `I hit a problem and stopped: ${e.message}`));
    return { ok: true, status: status() };
  }

  function stop() {
    if (current?.state !== "running") return false;
    current.stopRequested = true;
    return true;
  }

  function end(r, state, text) {
    r.state = state;
    r.endedAt = new Date().toISOString();
    log(r, text);
  }

  async function work(r, issue) {
    log(r, `Starting #${r.issue}: ${r.title}`);
    await git(["fetch", "origin", "main"]);
    if (!fs.existsSync(r.worktree)) {
      const hasBranch = (await exec("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${r.branch}`], { cwd: repoRoot, env })).code === 0;
      await git(hasBranch ? ["worktree", "add", r.worktree, r.branch] : ["worktree", "add", r.worktree, "-b", r.branch, "origin/main"]);
    }
    const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], r.worktree);
    if (head !== r.branch) throw new Error(`${r.worktree} is on ${head}, not ${r.branch}`);
    // Her tests need node-bot's packages; the link is read through only
    // (writes are held to the worktree's real path below).
    const modules = path.join(repoRoot, "node-bot", "node_modules");
    const link = path.join(r.worktree, "node-bot", "node_modules");
    if (fs.existsSync(modules) && !fs.existsSync(link)) fs.symlinkSync(modules, link, "junction");

    log(r, "Working on it in my worktree.");
    const tools = worktreeTools(r);
    const reply = await runLoop(buildPrompt(r, issue), tools, {
      goal: `Implement issue #${r.issue}: ${r.title}`,
      maxRounds: MAX_ROUNDS,
      maxMs: Infinity,
      maxTokens: 2048,
      overrideSystemPrompt:
        "You are Mana, working on your own source code as a careful, minimal software engineer. Use the tools; don't guess at code you haven't read.",
    });
    const summary = stripAttribution(reply?.content);

    if (r.halt) return end(r, r.halt.state, `${r.halt.text} My work so far is in ${r.worktree}.`);
    if (r.stopRequested) return end(r, "stopped", "I stopped, as you asked. My work so far is in the worktree.");
    if (r.refuted) {
      return end(
        r,
        "needs-you",
        `My reviewer found a way my change to ${r.refuted.path} breaks: ${r.refuted.failingCase}. I stopped there -- how do you want it handled?`,
      );
    }
    // Everything in the worktree, whoever wrote it (her tests run code too).
    await git(["add", "-A"], r.worktree);
    const changed = (await git(["-c", "core.quotePath=false", "diff", "--cached", "--name-only", "--no-renames"], r.worktree))
      .split(/\r?\n/)
      .filter(Boolean);
    if (!changed.length) return end(r, "no-change", `I didn't end up changing anything for #${r.issue}.${summary ? ` ${summary}` : ""}`);
    if (!r.finished || /^Not done yet/i.test(summary)) {
      return end(r, "not-done", `I couldn't finish #${r.issue}. ${summary}`.trim());
    }
    if (!r.lastTestPassed) return end(r, "tests-failing", `My tests aren't passing after my last change for #${r.issue}, so no PR.`);
    const touched = changed.filter((f) => guard.protectedPathFor(path.join(r.worktree, f)));
    if (touched.length) return end(r, "needs-you", `My change touches my guardrails (${touched.join(", ")}), so I didn't push it.`);

    const secret = findSecret(await git(["diff", "--cached"], r.worktree), env);
    if (secret) return end(r, "needs-you", `My diff has ${secret} in it, so I didn't push it. It's staged in ${r.worktree}.`);
    await git(["commit", "-m", r.title.slice(0, 72), "-m", `Closes #${r.issue}.`], r.worktree);
    // Her own branch only, never main.
    await git(["push", "-u", "origin", `${r.branch}:refs/heads/${r.branch}`], r.worktree);
    const body = `Closes #${r.issue}.\n\n## What changed\n${summary.slice(0, 4000) || "(no summary)"}\n\n## Testing\n${r.lastTestCommand}: passed.`;
    let url;
    try {
      url = await gh(["pr", "create", "--base", "main", "--head", r.branch, "--title", r.title, "--body", body], r.worktree);
    } catch (e) {
      // A PR from an earlier run of this issue: the push updated it.
      url = JSON.parse(await gh(["pr", "view", r.branch, "--json", "url"], r.worktree)).url;
    }
    r.prUrl = url.split(/\s+/).pop();
    end(r, "pr-open", `My PR for #${r.issue} is ready: ${r.prUrl}`);
  }

  function buildPrompt(r, issue) {
    return `You're working on your own code, the Mana repo, to resolve issue #${r.issue} in your own git worktree (branch ${r.branch}). Nothing here touches your live copy.

Issue #${r.issue}: ${r.title}
${String(issue.body || "").slice(0, 4000)}

How to work:
- Find code with self_work__files and self_work__search, and read it with self_work__read.
- Change files with ${CODING_EDIT_TOOL_NAME}. Keep the change small and in the style around it, and add or update a test that fails without it.
- Run the tests you touched with ${CODING_TEST_TOOL_NAME} and fix what fails.
- Your guardrails (approval gate, hooks, tool risk, local-only mode, admin key, redaction) are off limits; writes there are refused.
- When the tests pass, call ${SESSION_GOAL_FINISH_TOOL_NAME}, then reply with a short first-person summary of what you changed and how you tested it. It becomes the PR description.`;
  }

  function worktreeTools(r) {
    const root = r.worktree;
    const goal = createSessionGoalToolSource();
    // #1007's no-progress detector: a step makes progress when it reads
    // something not read before, changes a file, or gets a new test result.
    let stepsWithoutProgress = 0;
    let progressed = false;
    let lastTestOutcome = null;
    const looked = new Set();

    // Inside the worktree by name and by real path: a link (node_modules)
    // can't carry a write out of it.
    function inside(rel) {
      const full = resolveWithinRoot(root, rel);
      let existing = full;
      while (!fs.existsSync(existing)) existing = path.dirname(existing);
      const real = path.relative(fs.realpathSync.native(root), fs.realpathSync.native(existing));
      if (real.startsWith("..") || path.isAbsolute(real)) throw new Error(`${rel} leads outside my worktree`);
      return full;
    }
    const posix = (full) => path.relative(root, full).split(path.sep).join("/");

    async function files({ contains }) {
      const needle = String(contains || "").toLowerCase();
      const all = (await git(["ls-files"], root)).split(/\r?\n/);
      const hits = all.filter((f) => f.toLowerCase().includes(needle));
      return hits.slice(0, MAX_LIST).join("\n") + (hits.length > MAX_LIST ? `\n...and ${hits.length - MAX_LIST} more` : "");
    }

    async function search({ text, path: where }) {
      if (!text) throw new Error("text is required");
      const args = ["grep", "-n", "-I", "-F", "-e", String(text)];
      if (where) args.push("--", posix(inside(where)));
      const r2 = await exec("git", args, { cwd: root, env });
      if (r2.code === 1) return "No matches.";
      if (r2.code !== 0) throw new Error(r2.stderr.trim());
      const lines = r2.stdout.split(/\r?\n/).filter(Boolean);
      return lines.slice(0, 60).map((l) => l.slice(0, 300)).join("\n") + (lines.length > 60 ? `\n...${lines.length - 60} more` : "");
    }

    function read({ path: rel, start_line, end_line }) {
      const full = inside(rel);
      if (isCredentialPath(path.basename(full))) throw new Error("refusing to read a credential file");
      const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
      const from = Math.max(1, Number(start_line) || 1);
      const to = Math.min(lines.length, Number(end_line) || from + MAX_READ_LINES - 1, from + MAX_READ_LINES - 1);
      const shown = lines.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join("\n");
      return `${rel} lines ${from}-${to} of ${lines.length}\n${shown}`;
    }

    async function edit({ path: rel, old_text: oldText = "", new_text: newText, summary }) {
      if (typeof newText !== "string") throw new Error("new_text is required");
      const full = inside(rel);
      const relPath = posix(full);
      if (isCredentialPath(path.basename(full))) throw new Error("refusing to write a credential file");
      if (/(^|\/)(\.git|node_modules)(\/|$)/i.test(relPath)) throw new Error(`${relPath} isn't mine to write`);
      const blocked = guard.protectedPathFor(full);
      if (blocked) throw new Error(guard.protectedPathMessage(blocked));
      const exists = fs.existsSync(full);
      const original = exists ? fs.readFileSync(full, "utf8") : "";
      const eol = original.includes("\r\n") ? "\r\n" : "\n";
      const norm = (s) => String(s).replace(/\r?\n/g, eol);
      let next;
      if (exists) {
        if (!oldText) throw new Error(`${relPath} exists: give old_text to replace`);
        const parts = original.split(norm(oldText));
        if (parts.length !== 2) throw new Error(`old_text must match ${relPath} exactly once (found ${parts.length - 1})`);
        next = parts.join(norm(newText));
      } else {
        if (oldText) throw new Error(`${relPath} doesn't exist yet: leave old_text empty to create it`);
        next = norm(newText);
      }
      // Truncation and syntax checks, and the diff the reviewer reads.
      const proposal = proposals.createProposal({ relativePath: relPath, originalContent: original, proposedContent: next, summary });
      const review = reviewEdit ? await reviewEdit(proposal) : null;
      if (review?.verdict === "refuted") {
        r.refuted = { path: relPath, failingCase: review.failingCase };
        log(r, `My reviewer refuted my change to ${relPath}: ${review.failingCase}`);
        return JSON.stringify({ status: "blocked", error: `refuted by review: ${review.failingCase}` });
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, next, "utf8");
      r.lastTestPassed = false;
      if (next !== original) progressed = true;
      log(r, `Changed ${relPath}${summary ? `: ${summary}` : ""}`);
      return JSON.stringify({ status: "ok", relativePath: relPath, adversarialReview: review || undefined, diff: proposal.diff.slice(0, 2000) });
    }

    async function tests({ path: rel }) {
      const target = rel ? posix(inside(rel)) : "";
      let cwd = path.join(root, "node-bot");
      let command = "node run_tests.js";
      const nodeTest = /^node-bot\/(test\/[\w.-]+\.test\.js)$/.exec(target);
      if (nodeTest) command = `node --test ${nodeTest[1]}`;
      if (target.startsWith("windows-native-launcher")) {
        cwd = path.join(root, "windows-native-launcher");
        command = "dotnet test ManaNativeLauncher.Tests -v q --disable-build-servers";
        const cls = /(\w+Tests)\.cs$/.exec(target);
        if (cls) command += ` --filter FullyQualifiedName~${cls[1]}`;
      }
      // Wait out a RAM spike (a game loading, a build) before adding a test run to it.
      for (let waited = 0; ramPercent() > MAX_RAM_PERCENT; waited += 60000) {
        if (waited >= RAM_WAIT_MS) return halt("paused", `RAM stayed above ${MAX_RAM_PERCENT}%, so I paused.`);
        await sleep(60000);
      }
      log(r, `Running ${command}`);
      const clean = testEnv(env);
      const result = await runTests(command, cwd, {
        spawnImpl: (c, o) => spawn(c, { ...o, env: clean }),
        timeoutMs: TEST_TIMEOUT_MS,
      });
      const passed = result.exitCode === 0 && !result.timedOut;
      r.lastTestPassed = passed;
      const outcome = `${passed}|${result.output}`;
      if (outcome !== lastTestOutcome) progressed = true;
      lastTestOutcome = outcome;
      r.lastTestCommand = command;
      log(r, `${command}: ${passed ? "passed" : "failed"}`);
      return JSON.stringify({ status: "ok", command, passed, ...result });
    }

    const executors = {
      self_work__files: files,
      self_work__search: search,
      self_work__read: read,
      [CODING_EDIT_TOOL_NAME]: edit,
      [CODING_TEST_TOOL_NAME]: tests,
    };
    // A blocked result ends goal mode (it treats it as waiting on me).
    function halt(state, text) {
      r.halt ||= { state, text };
      return JSON.stringify({ status: "blocked", error: r.halt.text });
    }

    function dispatch(name, args) {
      if (name === SESSION_GOAL_FINISH_TOOL_NAME) {
        r.finished = true;
        return goal.executeTool(name, args);
      }
      if (!(name in executors)) throw new Error(`unknown tool: ${name}`);
      return executors[name](args || {});
    }

    return {
      tools: [...TOOL_SCHEMAS, ...GOAL_TOOL_SCHEMAS],
      isKnownTool: (name) => name in executors || name === SESSION_GOAL_FINISH_TOOL_NAME,
      async executeTool(name, args) {
        if (r.stopRequested) return JSON.stringify({ status: "blocked", error: "stopped by Yuuzulight" });
        if (r.halt) return JSON.stringify({ status: "blocked", error: r.halt.text });
        if (isGaming()) return halt("paused", "A game started, so I stopped.");
        if (stepsWithoutProgress >= MAX_STEPS_WITHOUT_PROGRESS) {
          return halt("stuck", `I went ${MAX_STEPS_WITHOUT_PROGRESS} steps without anything new, so I stopped.`);
        }
        stepsWithoutProgress += 1;
        progressed = false;
        const result = await dispatch(name, args);
        const key = `${name}:${JSON.stringify(args || {})}`;
        if (name.startsWith("self_work__") && !looked.has(key)) {
          looked.add(key);
          progressed = true;
        }
        if (progressed) stepsWithoutProgress = 0;
        return result;
      },
    };
  }

  return { start, startIdle, stop, status, _current: () => current };
}

module.exports = { createSelfWork, slugify, stripAttribution, findSecret, testEnv, TASK_LABEL };
