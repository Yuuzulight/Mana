// #1011: a merged PR broke something. Its own issue first, then a revert
// PR via gh: a worktree at D:\Mana-worktrees\revert-<N> from a fresh
// origin/main on branch revert/<N>, `git revert` of the merge, and a PR
// that says "Closes #<revert issue>". Never merged here. Rolling the
// running build back is try-pr.ps1 -Previous's job (the caller runs it).
const path = require("node:path");
const { execFile } = require("node:child_process");

function defaultExec(cmd, args, { cwd } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || (err && err.message) || "") });
    });
  });
}

function createReverter({ repoRoot = path.join(__dirname, ".."), worktreesDir, exec = defaultExec } = {}) {
  const root = path.resolve(repoRoot);
  const worktrees = path.resolve(worktreesDir || path.join(path.dirname(root), "Mana-worktrees"));

  async function run(cmd, args, cwd = root) {
    const r = await exec(cmd, args, { cwd });
    if (r.code !== 0) throw new Error(`${cmd} ${args.slice(0, 2).join(" ")} failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
    return r.stdout.trim();
  }

  // {ok, issueUrl, prUrl, mergeCommit} or {ok: false, error}.
  async function revert(prNumber, reason = "") {
    const n = Number(prNumber);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "Which PR? Give me its number." };
    try {
      const pr = JSON.parse(await run("gh", ["pr", "view", String(n), "--json", "number,title,state,mergeCommit"]));
      if (pr.state !== "MERGED" || !pr.mergeCommit?.oid) return { ok: false, error: `#${n} isn't merged, so there's nothing to revert.` };
      const sha = pr.mergeCommit.oid;
      const branch = `revert/${n}`;
      const worktree = path.join(worktrees, `revert-${n}`);

      await run("git", ["fetch", "origin", "main"]);
      await run("git", ["worktree", "add", worktree, "-b", branch, "origin/main"]);
      // A merge commit reverts against its first parent; a squash or rebase merge has one.
      const parents = (await run("git", ["rev-list", "--parents", "-n", "1", sha], worktree)).split(/\s+/).length - 1;
      const reverted = await exec("git", ["revert", "--no-edit", ...(parents > 1 ? ["-m", "1"] : []), sha], { cwd: worktree });
      if (reverted.code !== 0) {
        await exec("git", ["revert", "--abort"], { cwd: worktree });
        return { ok: false, error: `#${n} doesn't revert cleanly on today's main; it needs a hand-made fix. ${reverted.stderr.trim().slice(0, 300)}` };
      }

      const why = String(reason || "").trim();
      const issueUrl = await run("gh", [
        "issue", "create",
        "--title", `Revert #${n}: ${pr.title}`,
        "--body", `#${n} broke something after it was merged, so I'm reverting it.${why ? `\n\nWhat broke: ${why}` : ""}`,
      ]);
      const issue = issueUrl.split("/").pop();
      await run("git", ["push", "-u", "origin", `${branch}:refs/heads/${branch}`], worktree);
      const prUrl = await run(
        "gh",
        [
          "pr", "create", "--base", "main", "--head", branch,
          "--title", `Revert #${n}: ${pr.title}`,
          "--body", `Closes #${issue}.\n\nReverts #${n} (merge ${sha.slice(0, 7)}) with \`git revert\`, nothing else.${why ? `\n\nWhat broke: ${why}` : ""}`,
        ],
        worktree,
      );
      return { ok: true, issueUrl, prUrl: prUrl.split(/\s+/).pop(), mergeCommit: sha };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return { revert };
}

module.exports = { createReverter };
