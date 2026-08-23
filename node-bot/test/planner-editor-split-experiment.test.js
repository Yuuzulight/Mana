const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildPlanPrompt,
  buildDiffPrompt,
  runSingleModelPath,
  runPlannerEditorPath,
  checkDiffApplies,
  estimatePlanAdherence,
  runExperiment,
} = require("../tools/planner-editor-split-experiment");

// Fully fake checkDiffApplies deps -- no real scratch copy or git call in
// any of these tests, matching this file's whole point: validate the
// harness's own mechanics before it's ever pointed at real models/disk.
function fakeApplyDeps(applies, error = null) {
  return {
    createScratch: () => "/fake/scratch",
    removeScratch: () => {},
    writeFileSync: () => {},
    execSync: () => {
      if (!applies) {
        const e = new Error("patch failed");
        e.stderr = error || "error: patch does not apply";
        throw e;
      }
    },
  };
}

let clockValue;
function fakeNow() {
  return clockValue;
}

// 1. Clean diff, single-model path, applies successfully.
test("runSingleModelPath: clean diff applies successfully", async () => {
  clockValue = 1000;
  const callCoderModel = async () => {
    clockValue += 500;
    return "diff --git a/x.js b/x.js\n+real change";
  };
  const result = await runSingleModelPath("add a function", { callCoderModel, now: fakeNow });
  assert.equal(result.latencyMs, 500);
  const applyResult = checkDiffApplies(result.diff, { repoRoot: "/repo", ...fakeApplyDeps(true) });
  assert.equal(applyResult.applies, true);
});

// 2. Clean diff, split path, applies successfully, high plan adherence.
test("runPlannerEditorPath: plan and diff share vocabulary -> high adherence", async () => {
  clockValue = 0;
  const callQualityModel = async () => {
    clockValue += 200;
    return "Add a validateInput function to utils.js that checks the email format.";
  };
  const callCoderModel = async () => {
    clockValue += 300;
    return "diff --git a/utils.js b/utils.js\n+function validateInput(email) { /* checks email format */ }";
  };
  const result = await runPlannerEditorPath("validate emails", { callQualityModel, callCoderModel, now: fakeNow });
  assert.equal(result.planLatencyMs, 200);
  assert.equal(result.diffLatencyMs, 300);
  assert.equal(result.totalLatencyMs, 500);
  const adherence = estimatePlanAdherence(result.plan, result.diff);
  assert.ok(adherence > 0.3, `expected meaningful overlap, got ${adherence}`);
});

// 3. Malformed/garbage diff -- doesn't apply.
test("checkDiffApplies: garbage text reports applies:false with the underlying error", () => {
  const result = checkDiffApplies("this is not a diff at all", {
    repoRoot: "/repo",
    ...fakeApplyDeps(false, "error: corrupt patch"),
  });
  assert.equal(result.applies, false);
  assert.match(result.error, /corrupt patch/);
});

// 4. Empty diff response.
test("checkDiffApplies: empty diff is applies:false without even attempting git", () => {
  let execCalled = false;
  const deps = fakeApplyDeps(true);
  deps.execSync = () => {
    execCalled = true;
  };
  const result = checkDiffApplies("   ", { repoRoot: "/repo", ...deps });
  assert.equal(result.applies, false);
  assert.equal(result.error, "empty diff");
  assert.equal(execCalled, false);
});

// 5. Coder model throws -- single path error handling inside runExperiment.
test("runExperiment: a coder-model error on the single path doesn't lose the split path's result", async () => {
  clockValue = 0;
  const callCoderModel = async (prompt) => {
    if (!prompt.includes("plan for this change")) throw new Error("coder model unavailable");
    clockValue += 100;
    return "diff --git a/x.js b/x.js\n+ok";
  };
  const callQualityModel = async () => {
    clockValue += 50;
    return "a short plan";
  };
  const { results } = await runExperiment(
    [{ id: "case-1", task: "do something" }],
    { callCoderModel, callQualityModel, now: fakeNow, repoRoot: "/repo", ...fakeApplyDeps(true) },
  );
  assert.equal(results[0].single.error, "coder model unavailable");
  assert.equal("error" in results[0].split, false);
});

// 6. Quality model throws -- split path error handling.
test("runExperiment: a quality-model error surfaces as the split case's error, not a thrown exception", async () => {
  clockValue = 0;
  const callQualityModel = async () => {
    throw new Error("quality model timed out");
  };
  const callCoderModel = async () => {
    clockValue += 100;
    return "diff --git a/x.js b/x.js\n+ok";
  };
  const { results } = await runExperiment(
    [{ id: "case-1", task: "do something" }],
    { callCoderModel, callQualityModel, now: fakeNow, repoRoot: "/repo", ...fakeApplyDeps(true) },
  );
  assert.equal(results[0].split.error, "quality model timed out");
  assert.equal("error" in results[0].single, false);
});

// 7. Diff completely ignores the plan -- low adherence.
test("estimatePlanAdherence: unrelated plan and diff score low", () => {
  const plan = "Refactor the authentication middleware to support OAuth tokens.";
  const diff = "diff --git a/README.md b/README.md\n+Added a typo fix in the changelog section.";
  const adherence = estimatePlanAdherence(plan, diff);
  assert.ok(adherence < 0.2, `expected low overlap, got ${adherence}`);
});

// 8. Plan closely followed -- high adherence (same idea as #2, phrased as
// its own explicit adherence-only check).
test("estimatePlanAdherence: near-identical vocabulary scores high", () => {
  const plan = "Add input validation to the signup form handler.";
  const diff = "diff --git a/signup.js b/signup.js\n+// Added input validation to the signup form handler.";
  const adherence = estimatePlanAdherence(plan, diff);
  assert.ok(adherence > 0.8, `expected near-total overlap, got ${adherence}`);
});

// 9. Aggregate summary across a mix of successes and failures.
test("runExperiment: summary aggregates latency/success rate only across cases that didn't error", async () => {
  clockValue = 0;
  let callCount = 0;
  const callCoderModel = async (prompt) => {
    callCount++;
    if (prompt.includes("case-2") && !prompt.includes("plan for this change")) {
      throw new Error("boom");
    }
    clockValue += 100;
    return callCount % 2 === 0
      ? "not a real diff"
      : "diff --git a/x.js b/x.js\n+ok";
  };
  const callQualityModel = async () => {
    clockValue += 50;
    return "a plan";
  };
  const applyDeps = { execSync: (cmd, opts) => {
    // Fail the "not a real diff" case, succeed the other -- distinguished
    // by reading the patch file writeFileSync stored, matching real
    // git-apply's real behavior of failing on bad content.
    if (lastWrittenDiff.includes("not a real diff")) {
      const e = new Error("fail");
      e.stderr = "error: malformed patch";
      throw e;
    }
  } };
  let lastWrittenDiff = "";
  const { summary } = await runExperiment(
    [
      { id: "case-1", task: "case-1 task" },
      { id: "case-2", task: "case-2 task" },
    ],
    {
      callCoderModel,
      callQualityModel,
      now: fakeNow,
      repoRoot: "/repo",
      createScratch: () => "/fake/scratch",
      removeScratch: () => {},
      writeFileSync: (p, content) => {
        lastWrittenDiff = content;
      },
      execSync: applyDeps.execSync,
    },
  );
  // case-2's single path errors out (coder throws) -- summary must still
  // reflect case-1's real numbers, not be dragged to null/NaN by the error.
  assert.equal(summary.caseCount, 2);
  assert.equal(summary.single.meanLatencyMs, 100);
  assert.equal(summary.split.meanPlanLatencyMs, 50);
});

// 10. buildPlanPrompt/buildDiffPrompt shape checks -- the actual prompts
// sent to models, worth locking down since a malformed prompt would
// silently invalidate every measurement the harness produces.
test("buildPlanPrompt asks for a plan, not a diff; buildDiffPrompt without a plan omits the plan section", () => {
  const planPrompt = buildPlanPrompt("add a feature");
  assert.match(planPrompt, /Do not write the actual diff/);
  assert.match(planPrompt, /add a feature/);

  const diffPromptNoPlan = buildDiffPrompt("add a feature", null);
  assert.doesNotMatch(diffPromptNoPlan, /plan for this change/);

  const diffPromptWithPlan = buildDiffPrompt("add a feature", "step 1: do the thing");
  assert.match(diffPromptWithPlan, /plan for this change/);
  assert.match(diffPromptWithPlan, /step 1: do the thing/);
});
