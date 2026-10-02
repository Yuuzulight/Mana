// #1265: Mana keeps Folio up to date. Once a day (the cron scheduler's
// "folio-update" script job) and on "Check now" (Settings > Approvals): the
// newest commit on Folio main whose CI passed on Windows and Ubuntu, if
// it's newer than the launcher's pin and wasn't tried before, becomes a PR
// -- a throwaway worktree off origin/main under D:\Mana-worktrees, with
// FolioCommit and FolioVersion set the way pack-folio.ps1 checks them,
// "Part of #<Keep Folio up to date>", and auto-merge on, so it merges once
// the required CI passes. It all goes through my "GitHub writes" approval
// setting. A PR whose CI fails stays open, I get a notice, and that Folio
// commit is never tried again.
const fs = require("node:fs");
const path = require("node:path");
const { resolveGitApprovalModes, runCommand, testEnv } = require("./ai/git-tool-source");

const FOLIO = "Yuuzulight/Folio";
const CSPROJ = "windows-native-launcher/ManaNativeLauncher.csproj";
const TRACKING_TITLE = "Keep Folio up to date";
const JOB_ACTION = "folio-update";
const NETWORK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_LISTED = 100;

// <FolioCommit>/<FolioVersion> in the csproj text.
function readPin(csproj) {
  const commit = /<FolioCommit>([0-9a-f]{40})<\/FolioCommit>/.exec(csproj)?.[1];
  const version = /<FolioVersion>([^<]+)<\/FolioVersion>/.exec(csproj)?.[1];
  if (!commit || !version) throw new Error(`${CSPROJ} has no FolioCommit/FolioVersion`);
  return { commit, version };
}

function setPin(csproj, commit, version) {
  readPin(csproj);
  return csproj
    .replace(/<FolioCommit>[0-9a-f]{40}<\/FolioCommit>/, `<FolioCommit>${commit}</FolioCommit>`)
    .replace(/<FolioVersion>[^<]+<\/FolioVersion>/, `<FolioVersion>${version}</FolioVersion>`);
}

// Folio's tools/pack.ps1 passes FolioBuild = the number of commits in the
// packed commit's history; Directory.Build.props makes the version of it.
function packVersion(props, count) {
  const prefix = /<VersionPrefix>([^<]+)<\/VersionPrefix>/.exec(props)?.[1]?.trim();
  const suffix = /<VersionSuffix>([^<]+)<\/VersionSuffix>/.exec(props)?.[1]?.trim();
  const version = (suffix ? `${prefix}-${suffix}` : String(prefix)).replace("$(FolioBuild)", String(count));
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) throw new Error(`can't work out Folio's package version (got "${version}")`);
  return version;
}

// Done, and passed on both OSes, nothing failed.
function isGreen(checks) {
  const ok = (c) => c.status === "completed" && ["success", "skipped", "neutral"].includes(c.conclusion);
  return (
    checks.length > 0 &&
    checks.every(ok) &&
    ["windows", "ubuntu"].every((os) => checks.some((c) => c.conclusion === "success" && c.name.toLowerCase().includes(os)))
  );
}

// "Merge pull request #12 from x/y\n\nTitle" -> { number: 12, title }.
function mergedPrs(messages) {
  return messages.flatMap((m) => {
    const hit = /^Merge pull request #(\d+)[^\n]*\n\n([^\n]*)/.exec(m);
    return hit ? [{ number: Number(hit[1]), title: hit[2].trim() }] : [];
  });
}

function prBody({ from, sha, version, prs, commits, tracking }) {
  const listed = prs.slice(-MAX_LISTED).map((p) => `- ${FOLIO}#${p.number} ${p.title}`);
  const more = prs.length > MAX_LISTED ? [`- ...and ${prs.length - MAX_LISTED} earlier ones`] : [];
  return [
    `Updates Folio from \`${from.slice(0, 7)}\` to \`${sha.slice(0, 7)}\` (Folio main, CI green on Windows and Ubuntu), packed as \`${version}\`.`,
    "",
    `Part of #${tracking}.`,
    "",
    `${commits} commit(s), ${prs.length} Folio PR(s):`,
    ...more,
    ...listed,
    "",
    `Full diff: https://github.com/${FOLIO}/compare/${from}...${sha}`,
    "",
    "Auto-merge is on, so this merges once the required CI passes. If CI fails it stays open, and this Folio commit isn't tried again.",
  ].join("\n");
}

// statePath: { enabled, trackingIssue, tried: { <sha>: { pr, url, state, version } } }.
// notify({ text, url }): her notice. approvalGate: server.js's.
function createFolioUpdater({ repoRoot, worktreesDir, exec = runCommand, approvalGate, isGaming = () => false, notify = () => {}, statePath, env = process.env } = {}) {
  const root = path.resolve(repoRoot || path.join(__dirname, ".."));
  const worktrees = path.resolve(worktreesDir || path.join(path.dirname(root), "Mana-worktrees"));
  // Keyed like git-tool-source's approvals for this repo ("d:/mana").
  const actionType = `folio-update:${root.replace(/\\/g, "/").toLowerCase()}`;
  const gitEnv = { ...testEnv(env), GIT_TERMINAL_PROMPT: "0" };
  const ghEnv = { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };
  let running = false;

  async function run1(cmd, args, cwd = root) {
    const r = await exec(cmd, args, { cwd, env: cmd === "git" ? gitEnv : ghEnv, timeoutMs: NETWORK_TIMEOUT_MS });
    if (r.code !== 0) throw new Error(`${cmd} ${args.slice(0, 2).join(" ")} failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
    return r.stdout.trim();
  }
  const git = (args, cwd) => run1("git", args, cwd);
  const gh = (args, cwd) => run1("gh", args, cwd);
  const ghJson = async (args) => JSON.parse(await gh(args));

  function load() {
    try {
      return JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch {
      return {};
    }
  }
  function save(state) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }
  const isEnabled = () => load().enabled !== false;

  async function newestGreen() {
    const shas = await ghJson(["api", `repos/${FOLIO}/actions/runs?branch=main&event=push&status=completed&per_page=30`, "--jq", "[.workflow_runs[].head_sha]"]);
    for (const sha of [...new Set(shas)]) {
      const checks = await ghJson(["api", `repos/${FOLIO}/commits/${sha}/check-runs?per_page=100`, "--jq", "[.check_runs[] | {name, status, conclusion}]"]);
      if (isGreen(checks)) return sha;
    }
    return null;
  }

  async function folioVersion(sha) {
    const props = await gh(["api", `repos/${FOLIO}/contents/Directory.Build.props?ref=${sha}`, "-H", "Accept: application/vnd.github.raw"]);
    const [owner, name] = FOLIO.split("/");
    const query = `{repository(owner:"${owner}",name:"${name}"){object(expression:"${sha}"){... on Commit{history{totalCount}}}}}`;
    const count = (await ghJson(["api", "graphql", "-f", `query=${query}`])).data.repository.object.history.totalCount;
    return packVersion(props, count);
  }

  async function trackingIssue(state) {
    if (state.trackingIssue) return state.trackingIssue;
    const found = (await ghJson(["issue", "list", "--state", "all", "--search", `"${TRACKING_TITLE}" in:title`, "--json", "number,title"])).find((i) => i.title === TRACKING_TITLE);
    const number =
      found?.number ??
      Number(
        (
          await gh([
            "issue", "create", "--title", TRACKING_TITLE,
            "--body", "Where the launcher's Folio updates collect. Once a day I check Folio main, and when there's a newer commit whose CI passed on Windows and Ubuntu, a PR moves the pin (FolioCommit/FolioVersion in windows-native-launcher/ManaNativeLauncher.csproj) to it and merges itself once the required CI passes. This stays open.",
          ])
        ).split("/").pop(),
      );
    save({ ...load(), trackingIssue: number });
    return number;
  }

  // The bump, once it's allowed. payload: { sha, version, from, prs, commits }.
  async function bump(payload) {
    if (isGaming()) throw new Error("A game is running, so I'm leaving git alone until it's closed.");
    const { sha, version } = payload;
    const short = sha.slice(0, 12);
    const branch = `folio/${short}`;
    const wt = path.join(worktrees, `folio-${short}`);
    const tracking = await trackingIssue(load());
    await git(["fetch", "origin", "main"]);
    await git(["worktree", "add", "-b", branch, wt, "origin/main"]);
    try {
      const file = path.join(wt, CSPROJ);
      fs.writeFileSync(file, setPin(fs.readFileSync(file, "utf8"), sha, version));
      await git(["add", "--", CSPROJ], wt);
      await git(["commit", "-m", `Update Folio to ${sha.slice(0, 7)} (${version})`], wt);
      await git(["push", "-u", "origin", `${branch}:refs/heads/${branch}`], wt);
      const title = `Update Folio to ${sha.slice(0, 7)} (${version})`;
      const url = (await gh(["pr", "create", "--base", "main", "--head", branch, "--title", title, "--body", prBody({ ...payload, tracking })], wt)).split(/\s+/).pop();
      const pr = Number(url.split("/").pop());
      const auto = await exec("gh", ["pr", "merge", String(pr), "--auto", "--merge"], { cwd: wt, env: ghEnv, timeoutMs: NETWORK_TIMEOUT_MS });
      const state = load();
      save({ ...state, tried: { ...state.tried, [sha]: { pr, url, state: "open", version } } });
      const text =
        auto.code === 0
          ? `I opened #${pr} to update Folio to ${sha.slice(0, 7)}; it merges itself once CI passes.`
          : `I opened #${pr} to update Folio to ${sha.slice(0, 7)}, but couldn't turn on auto-merge (${(auto.stderr || auto.stdout).trim().slice(0, 200)}), so it needs merging by hand once CI passes.`;
      notify({ text, url });
      return text;
    } finally {
      // Ours, fresh, without a node_modules link: nothing in it to keep.
      await exec("git", ["worktree", "remove", "--force", wt], { cwd: root, env: gitEnv });
      await exec("git", ["branch", "-D", branch], { cwd: root, env: gitEnv });
    }
  }
  approvalGate?.registerExecutor(actionType, bump);

  // Open bump PRs: merged or closed since, or CI failed (a notice, and
  // that commit stays tried).
  async function checkOpen() {
    const state = load();
    const open = Object.entries(state.tried || {}).filter(([, t]) => t.state === "open");
    for (const [sha, t] of open) {
      const { state: prState } = await ghJson(["pr", "view", String(t.pr), "--json", "state"]);
      if (prState !== "OPEN") {
        t.state = prState.toLowerCase();
        continue;
      }
      // gh exits non-zero while checks fail or are pending; its JSON is still the answer.
      const r = await exec("gh", ["pr", "checks", String(t.pr), "--json", "name,bucket,link"], { cwd: root, env: ghEnv, timeoutMs: NETWORK_TIMEOUT_MS });
      let checks = [];
      try {
        checks = JSON.parse(r.stdout);
      } catch {}
      const failed = checks.filter((c) => c.bucket === "fail");
      if (!failed.length) continue;
      t.state = "failed";
      t.failed = failed.map((c) => c.name);
      notify({
        text: `The Folio update #${t.pr} (Folio ${sha.slice(0, 7)}) failed CI: ${t.failed.join(", ")}. I left it open and won't try that Folio commit again.`,
        url: failed[0].link || t.url,
      });
    }
    if (open.length) save({ ...load(), tried: state.tried });
  }

  // What happened, as { status, ... }: off, gaming, busy, waiting,
  // current, tried, pending, opened (or what the approval said).
  async function run() {
    if (!isEnabled()) return { status: "off" };
    if (isGaming()) return { status: "gaming" };
    if (running) return { status: "busy" };
    running = true;
    try {
      await checkOpen();
      // One at a time: a newer bump would change the same two lines.
      const waiting = Object.entries(load().tried || {}).find(([, t]) => t.state === "open");
      if (waiting) return { status: "waiting", sha: waiting[0], pr: waiting[1].pr };
      await git(["fetch", "origin", "main"]);
      const pin = readPin(await git(["show", `origin/main:${CSPROJ}`]));
      const sha = await newestGreen();
      if (!sha || sha === pin.commit) return { status: "current", pin: pin.commit };
      const compare = await ghJson(["api", `repos/${FOLIO}/compare/${pin.commit}...${sha}`, "--jq", "{status, ahead_by}"]);
      if (compare.status !== "ahead") return { status: "current", pin: pin.commit };
      const tried = load().tried?.[sha];
      if (tried) return { status: "tried", sha, ...tried };
      const existing = await ghJson(["pr", "list", "--state", "all", "--head", `folio/${sha.slice(0, 12)}`, "--json", "number,state,url"]);
      if (existing.length) {
        const [p] = existing;
        const state = load();
        save({ ...state, tried: { ...state.tried, [sha]: { pr: p.number, url: p.url, state: p.state.toLowerCase() } } });
        return { status: "tried", sha, pr: p.number };
      }
      if (approvalGate.listPending().some((p) => p.actionType === actionType)) return { status: "pending", sha };

      const messages = (await gh(["api", "--paginate", `repos/${FOLIO}/compare/${pin.commit}...${sha}?per_page=100`, "--jq", ".commits[].commit.message | @json"]))
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const payload = { sha, version: await folioVersion(sha), from: pin.commit, prs: mergedPrs(messages), commits: compare.ahead_by };
      const summary = `Update Folio to ${sha.slice(0, 7)} (${payload.version}, ${payload.prs.length} Folio PR(s) since the pin): push folio/${sha.slice(0, 12)} to origin from ${root}, open a PR (Part of "${TRACKING_TITLE}") and turn on auto-merge, so it merges once the required CI passes`;

      // As ai/git-tool-source.js's gated(), on the "github" tier.
      const mode = resolveGitApprovalModes(approvalGate.getGitApprovalModes()).github;
      const never = approvalGate.listRemembered().some((r) => r.key === actionType && r.answer === "never");
      if (mode === "off" && !never) {
        const entry = { name: actionType, args: payload, decision: "no approval (setting)", summary };
        try {
          const text = await bump(payload);
          approvalGate.guardianAuditLog.append({ ...entry, ok: true });
          return { status: "opened", sha, text };
        } catch (e) {
          approvalGate.guardianAuditLog.append({ ...entry, ok: false, error: e.message });
          throw e;
        }
      }
      const outcome = await approvalGate.requestApproval(actionType, { summary, payload, forceReview: mode === "ask" });
      if (outcome.status === "approved") return { status: "opened", sha, text: outcome.result };
      return { status: outcome.status, sha, requestId: outcome.requestId, reason: outcome.reason };
    } finally {
      running = false;
    }
  }

  // The daily job, added at start when it's missing. The toggle is what turns it off.
  function ensureJob(cron) {
    if (cron.listJobs().some((j) => j.actionName === JOB_ACTION)) return;
    cron.addJob({ name: TRACKING_TITLE, jobType: "script", actionName: JOB_ACTION, schedule: { type: "daily", hour: 6, minute: 0 } });
  }

  return {
    run,
    ensureJob,
    status: () => ({ enabled: isEnabled(), tried: load().tried || {} }),
    setEnabled: (enabled) => save({ ...load(), enabled: Boolean(enabled) }),
  };
}

module.exports = { JOB_ACTION, createFolioUpdater, isGreen, mergedPrs, packVersion, readPin, setPin };
