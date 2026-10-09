// #1467: the oracle. A scripted agent that replays a case's real, merged fix through exactly the tools and loop
// Mana gets -- find the files, plan them, write each one, run the tests, the review passes, finish -- so the bench
// can tell a task or harness problem from a model one. If the oracle can't pass a case within its round budget, no
// model can, and the case or the harness needs fixing. Its rounds are the least a case takes.
// It needs no model: the bench runs it with --oracle, without the adversarial reviewer.
const { execFileSync } = require("node:child_process");

const TEST_RE = /(^|\/)tests?\/|\.test\.[cm]?js$|Tests?\.cs$/i;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
}

// What the fix did to each of its files: A added, M modified, D deleted.
function fixChanges(repoRoot, c) {
  const out = git(repoRoot, "diff", "--name-status", "--no-renames", c.base, c.fix, "--", ...c.fixFiles).trim();
  return out ? out.split(/\r?\n/).map((l) => ({ status: l[0], path: l.split("\t")[1] })) : [];
}

// runLoop(prompt, policy, opts) for the bench; opts.benchCase is the case.
function oracleLoop(repoRoot) {
  return async (prompt, policy, opts = {}) => {
    const c = opts.benchCase;
    if (!c?.fix) return { content: "Not done yet: the oracle needs a case with a merged fix." };
    let round = 0;
    const problems = [];
    const call = async (name, args) => {
      round += 1;
      opts.onRound?.(round, opts.maxRounds);
      try {
        return await policy.executeTool(name, args);
      } catch (e) {
        problems.push(`${name}: ${String(e.message).slice(0, 300)}`);
        return null;
      }
    };
    const changes = fixChanges(repoRoot, c);
    const code = changes.filter((f) => f.status !== "D");
    // Found first, as the locate-first rule wants: each existing file read once, a line is enough.
    for (const f of changes.filter((f) => f.status !== "A")) await call("self_work__read", { path: f.path, start_line: 1, end_line: 1 });
    await call("self_work__plan", {
      steps: ["Make the change the issue asks for", "Run the tests for it"],
      files: changes.map((f) => `${f.path}: part of the merged fix`),
    });
    for (const f of code) await call("coding__propose_edit", { path: f.path, new_text: git(repoRoot, "show", `${c.fix}:${f.path}`) });
    for (const f of changes.filter((f) => f.status === "D")) problems.push(`${f.path}: the fix deletes it, and no tool can`);
    await call("self_work__plan", { done: [1] });
    // The fix's own tests, through her test tool (the sandbox), JS and C# alike.
    for (const f of code.filter((f) => TEST_RE.test(f.path)).slice(0, 2)) {
      const out = await call("coding__run_tests", { path: f.path });
      if (out && !/"passed":true/.test(String(out))) problems.push(`coding__run_tests ${f.path}: ${String(out).slice(0, 300)}`);
    }
    await call("self_work__plan", { done: [2] });
    for (const pass of ["correctness", "edge cases", "scope"]) await call("self_work__review", { pass });
    await call("session_goal__finish", { reason: "The merged fix, replayed." });
    return { content: problems.length ? `Oracle problems:\n- ${problems.join("\n- ")}` : "Oracle: done.", rounds: round };
  };
}

function oracleModel(repoRoot) {
  return {
    model: "oracle (the merged fix, replayed)",
    start: async () => {},
    stop: async () => {},
    aborted: () => null,
    runLoop: oracleLoop(repoRoot),
    contextSize: async () => null,
  };
}

module.exports = { oracleModel, oracleLoop, fixChanges };
