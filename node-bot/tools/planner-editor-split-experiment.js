// Issue #351: "test a planner/editor split for coding tasks before adopting
// it" -- measures single-model vs. plan-then-diff coding, rather than
// assuming a split helps. A multi-model pipeline was deliberately rejected
// earlier in Mana's design (chaining models stacks latency and loses context
// at each handoff); reversing that needs evidence, not a hunch, so this
// exists to gather the evidence, not to implement the split itself.
//
// Everything that talks to a model or the filesystem is injectable (same DI
// convention this codebase uses throughout) so the harness's own logic --
// prompt assembly, diff-apply checking, metric aggregation -- is fully
// testable with fakes before it's ever pointed at a real model. Running the
// actual experiment (real models, real latency) is a separate, deliberate
// step -- see docs/roadmap/issue-351-planner-editor-split.md for how to run
// it once RAM/hardware conditions are safe.
const path = require("node:path");
const fs = require("node:fs");
const {
  createScratchWorkspaceCopy,
  removeScratchWorkspaceCopy,
} = require("../workspace-scratch-copy");

function buildPlanPrompt(task) {
  return `You are planning a code change. Describe the plan in a few sentences: which files to touch and what to change in each, and why. Do not write the actual diff.\n\nTask: ${task}`;
}

function buildDiffPrompt(task, plan) {
  const planSection = plan
    ? `\n\nA plan for this change has already been written:\n${plan}\n\nFollow it unless it's clearly wrong.`
    : "";
  return `Write a unified diff (git diff format) that accomplishes this task. Reply with only the diff, no commentary.${planSection}\n\nTask: ${task}`;
}

// Single-model path: one call, no plan step.
async function runSingleModelPath(task, { callCoderModel, now = Date.now }) {
  const startedAt = now();
  const diff = await callCoderModel(buildDiffPrompt(task, null));
  return { diff, latencyMs: now() - startedAt };
}

// Split path: quality model plans, coder model writes the diff informed by it.
async function runPlannerEditorPath(task, { callQualityModel, callCoderModel, now = Date.now }) {
  const planStartedAt = now();
  const plan = await callQualityModel(buildPlanPrompt(task));
  const planLatencyMs = now() - planStartedAt;

  const diffStartedAt = now();
  const diff = await callCoderModel(buildDiffPrompt(task, plan));
  const diffLatencyMs = now() - diffStartedAt;

  return { plan, diff, planLatencyMs, diffLatencyMs, totalLatencyMs: planLatencyMs + diffLatencyMs };
}

// Real diff-apply check (git apply --check against a scratch copy of the
// repo), not a syntax guess -- reuses #422's scratch-copy infra so this
// never touches the live tree. Returns {applies, error}. A diff that isn't
// even parseable (empty, prose instead of a real diff) counts as
// applies:false with the underlying git error as the reason, same as a
// diff that parses but doesn't match the target files.
function checkDiffApplies(
  diff,
  { repoRoot, createScratch = createScratchWorkspaceCopy, removeScratch = removeScratchWorkspaceCopy, execSync = require("node:child_process").execSync, writeFileSync = fs.writeFileSync },
) {
  if (!diff || !diff.trim()) {
    return { applies: false, error: "empty diff" };
  }
  const scratchDir = createScratch(repoRoot);
  try {
    const diffPath = path.join(scratchDir, "__experiment.patch");
    writeFileSync(diffPath, diff);
    try {
      execSync(`git apply --check "${diffPath}"`, { cwd: scratchDir, stdio: "pipe" });
      return { applies: true, error: null };
    } catch (e) {
      const stderr = e && e.stderr ? String(e.stderr) : (e && e.message) || String(e);
      return { applies: false, error: stderr.trim() };
    }
  } finally {
    removeScratch(scratchDir);
  }
}

// Rough, human-facing signal only -- explicitly NOT used to decide anything
// automatically. #431 already found word-overlap ratio unreliable as a
// decision-making signal (auto-invalidation, killed after empirical
// testing); here it's just a number a human reviewing the results glances
// at alongside the actual plan/diff text, not something the experiment
// concludes from on its own.
function estimatePlanAdherence(plan, diff) {
  if (!plan || !diff) return null;
  const { significantWords, sharedWordCount } = require("../utils/word-overlap");
  const planWords = significantWords(plan);
  if (!planWords.length) return null;
  const diffWords = significantWords(diff);
  return Math.round((sharedWordCount(planWords, diffWords) / planWords.length) * 100) / 100;
}

// Runs both paths for every {id, task} case, collects per-case results plus
// an aggregate summary. Never throws on an individual case's model/apply
// failure -- one bad case shouldn't lose the rest of the run's data.
async function runExperiment(cases, options) {
  const results = [];
  for (const testCase of cases) {
    const caseResult = { id: testCase.id, task: testCase.task };
    try {
      caseResult.single = await runSingleModelPath(testCase.task, options);
      caseResult.single.applyCheck = checkDiffApplies(caseResult.single.diff, options);
    } catch (e) {
      caseResult.single = { error: (e && e.message) || String(e) };
    }
    try {
      caseResult.split = await runPlannerEditorPath(testCase.task, options);
      caseResult.split.applyCheck = checkDiffApplies(caseResult.split.diff, options);
      caseResult.split.planAdherence = estimatePlanAdherence(caseResult.split.plan, caseResult.split.diff);
    } catch (e) {
      caseResult.split = { error: (e && e.message) || String(e) };
    }
    results.push(caseResult);
  }

  const withSingle = results.filter((r) => r.single && !r.single.error);
  const withSplit = results.filter((r) => r.split && !r.split.error);
  const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);
  const successRate = (arr) => (arr.length ? arr.filter(Boolean).length / arr.length : null);

  const summary = {
    caseCount: cases.length,
    single: {
      meanLatencyMs: mean(withSingle.map((r) => r.single.latencyMs)),
      applySuccessRate: successRate(withSingle.map((r) => r.single.applyCheck?.applies)),
    },
    split: {
      meanTotalLatencyMs: mean(withSplit.map((r) => r.split.totalLatencyMs)),
      meanPlanLatencyMs: mean(withSplit.map((r) => r.split.planLatencyMs)),
      meanDiffLatencyMs: mean(withSplit.map((r) => r.split.diffLatencyMs)),
      applySuccessRate: successRate(withSplit.map((r) => r.split.applyCheck?.applies)),
      meanPlanAdherence: mean(withSplit.map((r) => r.split.planAdherence).filter((v) => v !== null)),
    },
  };

  return { results, summary };
}

module.exports = {
  buildPlanPrompt,
  buildDiffPrompt,
  runSingleModelPath,
  runPlannerEditorPath,
  checkDiffApplies,
  estimatePlanAdherence,
  runExperiment,
};
